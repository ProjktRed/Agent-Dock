import { execFile } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { renameWithRetry as rename } from "./fs-retry.mjs";
import path from "node:path";
import { promisify } from "node:util";
import { atomicWriteJson } from "./dashboard-state.mjs";
import { readDeferred } from "./supervisor-review.mjs";
import { STEP_DOWN } from "./engine-tuning.mjs";

const exec = promisify(execFile);
const git = (workspace, args) => exec("git", args, { cwd: workspace, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }).then((r) => r.stdout.trim());

/**
 * Sets the current task aside at a loop boundary. Its uncommitted work (tracked and untracked, not
 * ignored files) goes into a named git stash, so nothing is lost or reset; Agent Dock's own state
 * folder is excluded when it sits inside the workspace. Refuses when HEAD moved from the baseline.
 */
export async function deferTask({ workspace, stateDir, task, baselineSha, reason, stepDown = null }) {
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
  const entry = { id: task.id, name: task.name ?? task.id, reason: String(reason ?? "Deferred").slice(0, 400), stash, at: new Date().toISOString(), ...(stepDown ? { stepDown } : {}) };
  const list = await readDeferred(stateDir);
  await atomicWriteJson(path.join(stateDir, "deferred-tasks.json"), [...list.filter((d) => d.id !== task.id), entry]);
  return { entry };
}

/**
 * You set a blocked task aside (engine not running): the same as a Supervisor defer, from the app.
 * The work is stashed, the task listed as deferred, and its recovery state archived, so the next Run
 * starts with a fresh Assessment. Refuses when HEAD moved from the task's baseline (nothing to stash safely).
 */
export async function setAsideTask({ workspace, stateDir, reason = "Set aside by you", state = null, source = "app" }) {
  const file = path.join(stateDir, "current-task.json");
  let saved;
  try { saved = JSON.parse(await readFile(file, "utf8")); } catch { throw new Error("There is no current task to set aside"); }
  const { automation, ...task } = saved;
  if (!task.id) throw new Error("There is no current task to set aside");
  const result = await deferTask({ workspace, stateDir, task, baselineSha: automation?.recovery?.baselineSha, reason });
  if (result.blocked) throw new Error(result.blocked);
  const archive = path.join(stateDir, "set-aside");
  await mkdir(archive, { recursive: true });
  await rename(file, path.join(archive, `${String(task.id).replace(/[^\w.-]+/g, "_")}-${Date.now()}.json`));
  for (const name of ["pending-codex.json", "correction-task.json"]) await rm(path.join(stateDir, name), { force: true });
  await state?.record({ type: "task-set-aside", taskId: task.id, reason: result.entry.reason, stash: result.entry.stash?.message ?? null, source });
  return result.entry;
}

/** Adds the tasks another engine deferred (a parallel task's, in its own state folder) to stateDir's list,
 *  one entry per task id (the newer one wins). Their stashes stay valid: worktrees share the repository's stash.
 *  Returns how many entries were added or replaced. */
export async function mergeDeferred(fromStateDir, stateDir) {
  const incoming = await readDeferred(fromStateDir);
  if (!incoming.length) return 0;
  const ids = new Set(incoming.map((d) => d.id));
  const list = await readDeferred(stateDir);
  await atomicWriteJson(path.join(stateDir, "deferred-tasks.json"), [...list.filter((d) => !ids.has(d.id)), ...incoming]);
  return incoming.length;
}

/** The objective Assessment sees, with the deferred tasks it must not pick again. */
export async function objectiveWithDeferred(stateDir, objective) {
  const all = await readDeferred(stateDir);
  // A stepped-down task is redone now, smaller; once its step-down is over it is no longer listed.
  const active = STEP_DOWN.active;
  const redo = active ? all.find((d) => d.stepDown && d.id === active.taskId) : null;
  const list = all.filter((d) => !d.stepDown);
  let text = objective;
  if (list.length) text += `\n\nDeferred tasks (set aside by the Supervisor or by you; do not choose them or the same work again unless nothing else in the objective remains; their unfinished work is in the named git stash): ${list.map((d) => `${d.id} "${d.name}" (${d.reason})`).join("; ")}`;
  if (redo) text += `\n\nStepped down: ${redo.id} "${redo.name}" failed review twice at ${active.from} size. Redo its work now as ${active.to}-sized tasks, starting with its first part, from the current code (its earlier attempt is in git stash "${redo.stash?.message ?? "none"}"; do not apply it).${active.items.length ? ` Its plan items: ${active.items.join("; ")}.` : ""}`;
  return text;
}
