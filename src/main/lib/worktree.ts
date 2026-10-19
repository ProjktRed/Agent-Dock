import { existsSync } from "node:fs";
import path from "node:path";
import { run } from "./git";

// Parallel lanes: a project can run extra tasks side by side in linked git worktrees. Each lane is a
// worktree of the project on its own agent-dock/lane-<name> branch, registered as its own project
// (own engine, own state folder), so lanes never share a working tree or a lock. You merge a lane's
// branch when you are happy with it (or open a pull request from it).

export const laneSlug = (name: string) => name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

/** Where a lane's worktree goes: next to the project, in "<project>-lanes/<slug>". */
export const lanePath = (projectPath: string, slug: string) => path.join(`${path.resolve(projectPath)}-lanes`, slug);

const git = async (cwd: string, ...args: string[]) => {
  const r = await run("git", args, { cwd, timeoutMs: 120_000 });
  if (r.code !== 0) throw new Error(`git ${args.slice(0, 2).join(" ")} failed: ${(r.stderr || r.stdout).trim().split(/\r?\n/).pop()}`);
  return r.stdout.trim();
};

/** Creates the lane's worktree and branch from the project's current HEAD. */
export async function addLaneWorktree(projectPath: string, name: string): Promise<{ path: string; branch: string; slug: string }> {
  const slug = laneSlug(name);
  if (!slug) throw new Error("Give the lane a name with letters or digits.");
  const target = lanePath(projectPath, slug), branch = `agent-dock/lane-${slug}`;
  if (existsSync(target)) throw new Error(`${target} already exists.`);
  await git(projectPath, "rev-parse", "--verify", "HEAD");
  await git(projectPath, "worktree", "add", "-b", branch, target, "HEAD");
  return { path: target, branch, slug };
}

/** Removes the lane's worktree (its branch and commits stay, so nothing approved is lost). */
export async function removeLaneWorktree(projectPath: string, worktreePath: string, force = false): Promise<void> {
  if (!existsSync(worktreePath)) { await git(projectPath, "worktree", "prune"); return; }
  await git(projectPath, "worktree", "remove", ...(force ? ["--force"] : []), worktreePath);
}
