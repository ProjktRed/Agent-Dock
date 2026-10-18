import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { atomicWriteJson } from "./dashboard-state.mjs";
import { readDeferred } from "./supervisor-review.mjs";

const exec = promisify(execFile);
const git = (workspace, args) => exec("git", args, { cwd: workspace, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }).then((r) => r.stdout.trim());

/**
 * Sets the current task aside at a loop boundary. Its uncommitted work (tracked and untracked, not
 * ignored files) goes into a named git stash, so nothing is lost or reset; Agent Dock's own state
 * folder is excluded when it sits inside the workspace. Refuses when HEAD moved from the baseline.
 */
export async function deferTask({ workspace, stateDir, task, baselineSha, reason }) {
  const head = await git(workspace, ["rev-parse", "HEAD"]);
  if (baselineSha && head !== baselineSha) return { blocked: `Cannot defer ${task.id}: HEAD moved from the task's baseline` };
  const exclude = [];
  const relState = path.relative(workspace, stateDir);
  if (relState && !relState.startsWith("..") && !path.isAbsolute(relState)) exclude.push(`:(exclude)${relState.split(path.sep).join("/")}`);
  const dirty = await git(workspace, ["status", "--porcelain", "--untracked-files=all", "--", ".", ...exclude]);
  let stash = null;
  if (dirty) {
    const message = `Agent Dock: deferred ${task.id} - ${String(reason ?? "").replace(/\s+/g, " ").slice(0, 80)}`;
    await git(workspace, ["stash", "push", "--include-untracked", "-m", message, "--", ".", ...exclude]);
    stash = { ref: await git(workspace, ["rev-parse", "stash@{0}"]), message };
  }
  const entry = { id: task.id, name: task.name ?? task.id, reason: String(reason ?? "Deferred").slice(0, 400), stash, at: new Date().toISOString() };
  const list = await readDeferred(stateDir);
  await atomicWriteJson(path.join(stateDir, "deferred-tasks.json"), [...list.filter((d) => d.id !== task.id), entry]);
  return { entry };
}

/** The objective Assessment sees, with the deferred tasks it must not pick again. */
export async function objectiveWithDeferred(stateDir, objective) {
  const list = await readDeferred(stateDir);
  if (!list.length) return objective;
  return `${objective}\n\nDeferred tasks (set aside by the Supervisor; do not choose them or the same work again in this run): ${list.map((d) => `${d.id} "${d.name}" (${d.reason})`).join("; ")}`;
}
