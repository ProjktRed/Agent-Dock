import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { GitInfo } from "@shared/types";

export function run(command: string, args: string[], options: { cwd?: string; timeoutMs?: number; shell?: boolean } = {}): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      // GIT_OPTIONAL_LOCKS=0: monitoring must never take index locks or rewrite the index while an agent works.
      { cwd: options.cwd, windowsHide: true, timeout: options.timeoutMs ?? 15_000, shell: options.shell ?? false, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } },
      (error, stdout, stderr) => {
        const code = error ? (typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code) : 1) : 0;
        resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? (error ? error.message : "")), code });
      },
    );
  });
}

export function parsePorcelain(stdout: string): { status: string; path: string }[] {
  const records = stdout.split("\0").filter(Boolean);
  const files: { status: string; path: string }[] = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    const status = record.slice(0, 2);
    files.push({ status, path: record.slice(3).replaceAll("\\", "/") });
    if (/[RC]/.test(status) && records[index + 1]) index += 1;
  }
  return files;
}

export function isGitRepo(dir: string): boolean {
  return existsSync(path.join(dir, ".git"));
}

export async function gitInfo(workspace: string): Promise<GitInfo> {
  if (!existsSync(workspace)) return { isRepo: false, branch: null, head: null, remote: null, ahead: null, behind: null, changedFiles: [], error: "Folder not found" };
  if (!isGitRepo(workspace)) return { isRepo: false, branch: null, head: null, remote: null, ahead: null, behind: null, changedFiles: [] };
  const [status, branch, head, remote, counts] = await Promise.all([
    run("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: workspace }),
    run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: workspace }),
    run("git", ["rev-parse", "HEAD"], { cwd: workspace }),
    run("git", ["remote", "get-url", "origin"], { cwd: workspace }),
    run("git", ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"], { cwd: workspace }),
  ]);
  const [ahead, behind] = counts.code === 0 ? counts.stdout.trim().split(/\s+/).map(Number) : [null, null];
  return {
    isRepo: true,
    branch: branch.code === 0 ? branch.stdout.trim() : null,
    head: head.code === 0 ? head.stdout.trim() : null,
    remote: remote.code === 0 ? remote.stdout.trim() : null,
    ahead: Number.isFinite(ahead) ? (ahead as number) : null,
    behind: Number.isFinite(behind) ? (behind as number) : null,
    changedFiles: status.code === 0 ? parsePorcelain(status.stdout) : [],
    error: status.code === 0 ? undefined : status.stderr.trim() || "git status failed",
  };
}

export interface GitOwnerProblem {
  /** The repository's shared .git folder (outside the project for a git worktree). */
  dir: string;
  owner: string;
  user: string;
}

/**
 * Windows: the project's shared .git folder owned by another account (for example
 * CodexSandboxOffline, when a sandboxed Codex created the repository). QA commits there, and
 * Codex's sandbox must change that folder's permissions to allow it, which only its owner can.
 */
export async function sharedGitOwnerProblem(projectPath: string): Promise<GitOwnerProblem | null> {
  if (process.platform !== "win32") return null;
  const common = await run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: projectPath, timeoutMs: 5000 });
  if (common.code !== 0 || !common.stdout.trim()) return null;
  const dir = path.resolve(projectPath, common.stdout.trim());
  const result = await run("powershell", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Acl -LiteralPath '${dir.replace(/'/g, "''")}').Owner`], { timeoutMs: 15000 });
  const owner = result.stdout.trim();
  const user = `${process.env.USERDOMAIN ?? ""}\${process.env.USERNAME ?? ""}`;
  if (result.code !== 0 || !owner || owner.toLowerCase() === user.toLowerCase()) return null;
  return { dir, owner, user };
}

/** The Administrator command that makes the user the owner again (permissions are left as they are). */
export const ownerFixCommand = (p: GitOwnerProblem) => `icacls "${p.dir}" /setowner "${p.user}" /T /C`;
