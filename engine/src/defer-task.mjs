import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import { renameWithRetry as rename } from "./fs-retry.mjs";
import path from "node:path";
import { promisify } from "node:util";
import { atomicWriteJson } from "./dashboard-state.mjs";
import { safeGitArgs } from "./git-safe.mjs";

const exec = promisify(execFile);
const git = (workspace, args, { env, input } = {}) => {
  const run = exec("git", safeGitArgs(args), { cwd: workspace, windowsHide: true, maxBuffer: 16 * 1024 * 1024, ...(env ? { env } : {}) });
  if (input !== undefined) run.child.stdin.end(input);
  return run.then((r) => r.stdout.trim());
};

/**
 * Stashes the work under pathspec as `git stash push --include-untracked` does, and returns the stash commit.
 * Parallel task engines share one repository's stash: push and then reading stash@{0} could name another
 * engine's entry. So the stash commit is built here (index, worktree and untracked files, in temporary index
 * files), stored under its own sha (retried while another engine holds the stash ref), and only then is the
 * work removed from the worktree, as push removes it.
 */
async function stashWork(workspace, message, pathspec) {
  const head = await git(workspace, ["rev-parse", "HEAD"]);
  const commitTree = (tree, parents, text) => git(workspace, ["commit-tree", tree, ...parents.flatMap((p) => ["-p", p]), "-m", text]);
  const temp = path.join(os.tmpdir(), `agent-dock-stash-${process.pid}-${randomUUID()}`);
  const withIndex = (name) => ({ env: { ...process.env, GIT_INDEX_FILE: `${temp}-${name}` } });
  try {
    const indexTree = await git(workspace, ["write-tree"]);
    const index = await commitTree(indexTree, [head], `index on ${message}`);
    // The worktree's tracked files: the index, with every tracked change under pathspec (deletions too).
    await git(workspace, ["read-tree", indexTree], withIndex("work"));
    await git(workspace, ["add", "-u", "--", ...pathspec], withIndex("work"));
    const workTree = await git(workspace, ["write-tree"], withIndex("work"));
    // Untracked files that are not ignored, in a tree of their own (the stash's third parent).
    const untracked = (await exec("git", safeGitArgs(["ls-files", "--others", "--exclude-standard", "-z", "--", ...pathspec]), { cwd: workspace, windowsHide: true, maxBuffer: 16 * 1024 * 1024 })).stdout;
    const parents = [head, index];
    if (untracked) {
      await git(workspace, ["read-tree", "--empty"], withIndex("untracked"));
      await git(workspace, ["update-index", "--add", "-z", "--stdin"], { ...withIndex("untracked"), input: untracked });
      parents.push(await commitTree(await git(workspace, ["write-tree"], withIndex("untracked")), [], `untracked files on ${message}`));
    }
    const commit = await commitTree(workTree, parents, message);
    for (let tries = 1; ; tries++) {
      try { await git(workspace, ["stash", "store", "-m", message, commit]); break; }
      catch (error) { if (tries >= 20) throw error; await new Promise((r) => setTimeout(r, 50 * tries)); }
    }
    // Stored: now the worktree goes back to HEAD under pathspec, untracked files included.
    await git(workspace, ["restore", "--source=HEAD", "--staged", "--worktree", "--", ...pathspec]);
    await git(workspace, ["clean", "-fdq", "--", ...pathspec]);
    return commit;
  } finally {
    for (const name of ["work", "untracked"]) await rm(`${temp}-${name}`, { force: true }).catch(() => {});
  }
}

/** Tasks set aside (by you or for a missing tool), newest last. */
export async function readDeferred(stateDir) {
  try { const list = JSON.parse(await readFile(path.join(stateDir, "deferred-tasks.json"), "utf8")); return Array.isArray(list) ? list : []; } catch { return []; }
}

/** You removed the deferred mark: Assessment may choose these tasks again. Their stashes stay in git. Returns the removed entries. */
export async function undeferTasks(stateDir, ids) {
  const wanted = new Set(ids.map(String));
  const list = await readDeferred(stateDir);
  const removed = list.filter((d) => wanted.has(String(d.id)));
  if (removed.length) await atomicWriteJson(path.join(stateDir, "deferred-tasks.json"), list.filter((d) => !wanted.has(String(d.id))));
  return removed;
}

/** A stash was popped or dropped: deferred tasks that named it no longer have their work in a stash. */
export async function forgetDeferredStash(stateDir, ref) {
  const list = await readDeferred(stateDir);
  if (!list.some((d) => d.stash?.ref === ref)) return;
  await atomicWriteJson(path.join(stateDir, "deferred-tasks.json"), list.map((d) => (d.stash?.ref === ref ? { ...d, stash: null } : d)));
}

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
    stash = { ref: await stashWork(workspace, message, [".", ...exclude]), message };
  }
  const entry = { id: task.id, name: task.name ?? task.id, reason: String(reason ?? "Deferred").slice(0, 400), stash, planItems: [...(task.planItems ?? [])], at: new Date().toISOString() };
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
  // Entries from the step-down of earlier versions are set-aside tasks like any other.
  const list = await readDeferred(stateDir);
  let text = objective;
  if (list.length) text += `\n\nDeferred tasks (set aside by the Supervisor or by you; do not choose them or the same work again unless nothing else in the objective remains; their unfinished work is in the named git stash): ${list.map((d) => `${d.id} "${d.name}" (${d.reason})`).join("; ")}`;
  return text;
}
