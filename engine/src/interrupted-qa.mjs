import { execFile } from "node:child_process";
import { runCheckCommand } from "./qa-runner.mjs";

// Read-only git calls: no fsmonitor program from the repository's config runs (same results without it).
const git = (cwd, ...args) => new Promise((resolve) => execFile("git", ["-c", "core.fsmonitor=false", ...args], { cwd, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => resolve(error ? null : String(stdout).trim())));

/**
 * QA commits as its last step and then reports. If the engine was killed in between (Stop now, a
 * crash, a power cut), the commit exists but its report does not. Instead of blocking, the engine
 * checks the commit itself: exactly one commit on the task's baseline, only the task's paths, a clean
 * working tree, and the task's check command passing on it. Anything else returns null (the old,
 * safe behaviour: blocked for you).
 */
export async function interruptedQaCommit({ workspace, task, baselineSha, stateDir }) {
  const head = await git(workspace, "rev-parse", "HEAD");
  if (!head || head === baselineSha) return null;
  if ((await git(workspace, "rev-list", "--parents", "-n", "1", "HEAD")) !== `${head} ${baselineSha}`) return null;
  if ((await git(workspace, "status", "--porcelain=v1", "--untracked-files=all")) !== "") return null;
  const files = ((await git(workspace, "diff", "--no-renames", "--name-only", "-z", baselineSha, head)) ?? "").split("\0").filter(Boolean);
  const allowed = (task.allowedPaths ?? []).map((p) => p.replaceAll("\\", "/"));
  if (!files.length || files.some((file) => !allowed.includes(file))) return null;
  if (!task.qaCommand) return null;
  const check = await runCheckCommand(task.qaCommand, workspace, { stateDir }).catch(() => null);
  if (!check || check.exitCode !== 0) return null;
  return {
    status: "pass", commit: head, correction: "", manualReviewCause: null, task,
    output: `QA was interrupted after it committed ${head.slice(0, 7)}, before it could report. The engine checked that commit: one commit on the task's baseline, only the task's paths (${files.join(", ")}), a clean working tree, and \`${task.qaCommand}\` passes on it.`,
  };
}
