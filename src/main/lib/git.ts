import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { GitInfo } from "@shared/types";

export function run(command: string, args: string[], options: { cwd?: string; timeoutMs?: number; shell?: boolean; maxBuffer?: number } = {}): Promise<{ stdout: string; stderr: string; code: number }> {
  // git: no fsmonitor program from the repository's config runs (git gives the same results without it).
  if (command === "git") args = ["-c", "core.fsmonitor=false", ...args];
  return new Promise((resolve) => {
    execFile(
      // A shell runs one command line (Node joins it the same way; passing it whole avoids DEP0190).
      options.shell ? [command, ...args].join(" ") : command,
      options.shell ? [] : args,
      // GIT_OPTIONAL_LOCKS=0: monitoring must never take index locks or rewrite the index while an agent works.
      { cwd: options.cwd, windowsHide: true, timeout: options.timeoutMs ?? 15_000, shell: options.shell ?? false, maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } },
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

/**
 * At most this many workspaces are read at once (five git processes each): with many projects, the first
 * poll after start would otherwise start hundreds of git processes together (test report F8).
 */
const GIT_INFO_AT_ONCE = 3;
let reading = 0;
const queued: (() => void)[] = [];

export async function gitInfo(workspace: string): Promise<GitInfo> {
  if (reading >= GIT_INFO_AT_ONCE) await new Promise<void>((resolve) => queued.push(resolve));
  reading++;
  try {
    return await readGitInfo(workspace);
  } finally {
    reading--;
    queued.shift()?.();
  }
}

async function readGitInfo(workspace: string): Promise<GitInfo> {
  if (!existsSync(workspace)) return { isRepo: false, branch: null, head: null, remote: null, ahead: null, behind: null, changedFiles: [], error: "Folder not found" };
  if (!isGitRepo(workspace)) return { isRepo: false, branch: null, head: null, remote: null, ahead: null, behind: null, changedFiles: [] };
  const [status, branch, head, remote, counts] = await Promise.all([
    run("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: workspace, maxBuffer: 256 * 1024 * 1024 }),
    run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: workspace }),
    run("git", ["rev-parse", "HEAD"], { cwd: workspace }),
    run("git", ["remote", "get-url", "origin"], { cwd: workspace }),
    run("git", ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"], { cwd: workspace }),
  ]);
  const changed = status.code === 0 ? parsePorcelain(status.stdout) : [];
  const [ahead, behind] = counts.code === 0 ? counts.stdout.trim().split(/\s+/).map(Number) : [null, null];
  return {
    isRepo: true,
    branch: branch.code === 0 ? branch.stdout.trim() : null,
    head: head.code === 0 ? head.stdout.trim() : null,
    remote: remote.code === 0 ? remote.stdout.trim() : null,
    ahead: Number.isFinite(ahead) ? (ahead as number) : null,
    behind: Number.isFinite(behind) ? (behind as number) : null,
    changedFiles: changed,
    changedTotal: changed.length,
    error: status.code === 0 ? undefined : status.stderr.trim() || "git status failed",
  };
}

export interface GitOwnerProblem {
  /** The repository's shared .git folder (outside the project for a git worktree). */
  dir: string;
  owner: string;
  /** DOMAIN\name, for display. */
  user: string;
  /** The user's SID: the fix command names the account by SID, so no name lookup can pick another one. */
  sid: string;
}

/**
 * Windows: the project's shared .git folder owned by another account (for example
 * CodexSandboxOffline, when a sandboxed Codex created the repository). QA commits there, and
 * Codex's sandbox must change that folder's permissions to allow it, which only its owner can.
 * Owners are compared by SID.
 */
/** A repository folder on this computer: a local absolute path (no network share) with HEAD and objects/. */
function usableGitDir(dir: string): string | null {
  if (!path.isAbsolute(dir) || /^[\\/]{2}/.test(dir)) return null;
  if (process.platform === "win32" && !/^[A-Za-z]:[\\/]/.test(dir)) return null;
  try {
    return statSync(path.join(dir, "HEAD")).isFile() && statSync(path.join(dir, "objects")).isDirectory() ? dir : null;
  } catch {
    return null;
  }
}

/**
 * The repository's shared .git folder for a project folder, found the way git does: the nearest
 * .git folder, or a .git file ("gitdir: ...") whose folder names the shared one in "commondir".
 */
export function gitCommonDir(projectPath: string): string | null {
  for (let dir = path.resolve(projectPath); ; dir = path.dirname(dir)) {
    const dotGit = path.join(dir, ".git");
    try {
      if (statSync(dotGit).isDirectory()) return usableGitDir(dotGit);
      const gitdir = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, "utf8"))?.[1];
      if (!gitdir) return null;
      const worktreeDir = path.resolve(dir, gitdir);
      const common = path.join(worktreeDir, "commondir");
      return usableGitDir(existsSync(common) ? path.resolve(worktreeDir, readFileSync(common, "utf8").trim()) : worktreeDir);
    } catch {
      // no .git here: look in the parent folder
    }
    if (path.dirname(dir) === dir) return null;
  }
}

export async function sharedGitOwnerProblem(projectPath: string): Promise<GitOwnerProblem | null> {
  if (process.platform !== "win32") return null;
  // Read from disk, not through git: a foreign owner makes git refuse the repository ("dubious
  // ownership"), which is exactly the case this has to report, and git's own check stays on.
  const dir = gitCommonDir(projectPath);
  if (!dir) return null;
  const script = [
    `$acl = Get-Acl -LiteralPath ${psLiteral(dir)}`,
    "$me = [System.Security.Principal.WindowsIdentity]::GetCurrent()",
    "$acl.Owner",
    "$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value",
    "$me.Name",
    "$me.User.Value",
  ].join("; ");
  const result = await run("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { timeoutMs: 15000 });
  const [owner, ownerSid, user, sid] = result.stdout.split(/\r?\n/).map((l) => l.trim());
  if (result.code !== 0 || !ownerSid || !sid || ownerSid.toLowerCase() === sid.toLowerCase()) return null;
  return { dir, owner: owner && !owner.startsWith("O:") ? owner : ownerSid, user: user || sid, sid };
}

/**
 * The Administrator PowerShell command that makes the user the owner again (permissions are left as
 * they are). The folder is a PowerShell literal string; null for a folder name the command cannot
 * carry safely (or an unexpected SID), so no command is shown.
 */
export function ownerFixCommand(p: GitOwnerProblem): string | null {
  if (/[$`;\r\n]/.test(p.dir) || !/^S-\d+(?:-\d+)+$/i.test(p.sid)) return null;
  return `icacls ${psLiteral(p.dir)} /setowner '*${p.sid}' /T /C`;
}

/** A PowerShell single-quoted string: every quote character PowerShell treats as a single quote is doubled. */
export const psLiteral = (value: string) => `'${value.replace(/['‘-‛]/g, "$&$&")}'`;
