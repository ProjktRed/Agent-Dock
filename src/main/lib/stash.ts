import path from "node:path";
import type { StashEntry } from "@shared/types";
import { run } from "./git";

/** Stash and pop can rewrite many files; the 15-second default of run() is too short for a large workspace. */
const TIMEOUT_MS = 120_000;
const SEP = "\x1f";

/** Stashes made by Agent Dock: a set-aside task's (engine/src/defer-task.mjs) and Overview's Stash changes. */
export const isAgentDockStash = (message: string) => /(^|: )Agent Dock: /.test(message);

/** `git stash list` read as entries, newest first. %gs is the reflog subject: the message the stash was stored with. */
export function parseStashList(stdout: string): StashEntry[] {
  return stdout.split("\n").filter((line) => line.includes(SEP)).map((line) => {
    const [ref, sha, message, at] = line.replace(/\r$/, "").split(SEP);
    return { ref, sha, message, at: at || null, agentDock: isAgentDockStash(message) };
  });
}

export async function listStashes(workspace: string): Promise<StashEntry[]> {
  const result = await run("git", ["stash", "list", `--format=%gd${SEP}%H${SEP}%gs${SEP}%cI`], { cwd: workspace });
  if (result.code !== 0) throw new Error(result.stderr.trim() || "git stash list failed");
  return parseStashList(result.stdout);
}

/** Agent Dock's state folder when it sits inside the workspace: never stashed, never counted as a change. */
function stateExclude(workspace: string, stateDir: string): string[] {
  const rel = path.relative(workspace, stateDir);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? [`:(exclude)${rel.split(path.sep).join("/")}`] : [];
}

async function changes(workspace: string, exclude: string[]): Promise<string> {
  const status = await run("git", ["status", "--porcelain", "--untracked-files=all", "--", ".", ...exclude], { cwd: workspace });
  if (status.code !== 0) throw new Error(status.stderr.trim() || "git status failed");
  return status.stdout.trim();
}

/** Stash changes: every uncommitted change, untracked files included (ignored ones are not), under one named stash. */
export async function stashChanges(workspace: string, stateDir: string, now = new Date()): Promise<{ message: string }> {
  const exclude = stateExclude(workspace, stateDir);
  if (!(await changes(workspace, exclude))) throw new Error("There are no uncommitted changes to stash.");
  const message = `Agent Dock: stashed by you ${now.toISOString().slice(0, 16).replace("T", " ")} UTC`;
  const result = await run("git", ["stash", "push", "--include-untracked", "-m", message, "--", ".", ...exclude], { cwd: workspace, timeoutMs: TIMEOUT_MS });
  if (result.code !== 0) throw new Error(result.stderr.trim().split(/\r?\n/).pop() || "git stash failed");
  return { message };
}

/** Delete: drops the stash with this commit. Its work is gone from the list (git keeps the commit only until it is garbage-collected). */
export async function dropStash(workspace: string, sha: string): Promise<void> {
  const entry = (await listStashes(workspace)).find((s) => s.sha === sha);
  if (!entry) throw new Error("That stash is gone; the list is refreshed.");
  const result = await run("git", ["stash", "drop", entry.ref], { cwd: workspace });
  if (result.code !== 0) throw new Error(result.stderr.trim().split(/\r?\n/).pop() || "git stash drop failed");
}

/**
 * Pop: applies the stash with this commit to a clean workspace and drops it. Refused on uncommitted changes, so
 * the result is only the stash's work. A conflict leaves the conflicted files for you and keeps the stash, as git does.
 */
export async function popStash(workspace: string, stateDir: string, sha: string): Promise<{ conflicts: boolean; output: string }> {
  const entry = (await listStashes(workspace)).find((s) => s.sha === sha);
  if (!entry) throw new Error("That stash is gone; the list is refreshed.");
  if (await changes(workspace, stateExclude(workspace, stateDir))) throw new Error("The workspace has uncommitted changes. Commit or stash them first, then pop.");
  const result = await run("git", ["stash", "pop", entry.ref], { cwd: workspace, timeoutMs: TIMEOUT_MS });
  const output = `${result.stdout}\n${result.stderr}`.trim();
  if (result.code === 0) return { conflicts: false, output };
  if (/CONFLICT/.test(output)) return { conflicts: true, output };
  throw new Error(output.split(/\r?\n/).pop() || "git stash pop failed");
}
