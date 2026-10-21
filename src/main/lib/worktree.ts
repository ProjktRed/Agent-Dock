import { existsSync, lstatSync, readdirSync, realpathSync, rmdirSync, unlinkSync } from "node:fs";
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

// Parallel tasks (engine --parallel) keep a worktree, on an agent-dock/parallel-… branch, for each task
// that did not finish or did not merge, in "<project>-parallel/<task>-<run>". Cleanup removes them all;
// it only ever touches folders inside that "-parallel" folder and branches with that prefix.

export const PARALLEL_BRANCH = "agent-dock/parallel-";

/** The folder parallel tasks keep their worktrees in: next to the project, like lanes. */
export const parallelRoot = (projectPath: string) => `${path.resolve(projectPath)}-parallel`;

/** True when `target` is strictly inside `root` (never the root itself, never a sibling like "<root>2"). */
export function isInside(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** `git worktree list --porcelain`: each worktree's path and branch (null when detached). */
export function parseWorktreeList(stdout: string): { path: string; branch: string | null }[] {
  const out: { path: string; branch: string | null }[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) out.push({ path: path.resolve(line.slice(9)), branch: null });
    else if (line.startsWith("branch ") && out.length) out[out.length - 1].branch = line.slice(7).replace(/^refs\/heads\//, "");
  }
  return out;
}

export interface ParallelLeftovers {
  /** Kept worktrees inside "<project>-parallel" and their branch (null when not on a parallel branch). */
  worktrees: { path: string; branch: string | null }[];
  /** Every agent-dock/parallel-… branch cleanup deletes: the kept worktrees' and those with no worktree. */
  branches: string[];
}

/** What cleanup would remove, from git's worktree and branch lists. A parallel branch checked out in a
 *  worktree outside the "-parallel" folder (yours, or a lane's run) is left alone. All projects and lanes of
 *  a repo share its branches, so a branch with no worktree counts as this project's only when its name
 *  (agent-dock/parallel-<worktree folder>) matches a folder this project's runs used: one git lists inside
 *  "-parallel" (also when prunable), or one of `ownNames` (folders found there, or in the state folder).
 *  Any other is left alone. */
export function planParallelCleanup(projectPath: string, worktrees: { path: string; branch: string | null }[], branches: string[], ownNames: Iterable<string> = []): ParallelLeftovers {
  const root = parallelRoot(projectPath);
  const isParallel = (b: string | null): b is string => !!b && b.startsWith(PARALLEL_BRANCH) && b.length > PARALLEL_BRANCH.length;
  const inside = worktrees.filter((w) => isInside(root, w.path));
  const kept = inside.map((w) => ({ path: w.path, branch: isParallel(w.branch) ? w.branch : null }));
  const checkedOut = new Set(worktrees.map((w) => w.branch));
  const mine = new Set([...inside.map((w) => path.basename(w.path)), ...ownNames]);
  const loose = branches.filter((b) => isParallel(b) && !checkedOut.has(b) && mine.has(b.slice(PARALLEL_BRANCH.length)));
  return { worktrees: kept, branches: [...new Set([...kept.map((w) => w.branch).filter(isParallel), ...loose])] };
}

const folderNames = (dir: string) => { try { return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; } };

/** Lists the kept parallel worktrees and branches of a project. `stateDir` is the project's state folder,
 *  where the engine keeps a "parallel/<worktree folder>" folder for each parallel task. */
export async function listParallelLeftovers(projectPath: string, stateDir?: string): Promise<ParallelLeftovers> {
  const [list, refs] = await Promise.all([
    git(projectPath, "worktree", "list", "--porcelain"),
    git(projectPath, "for-each-ref", "--format=%(refname:short)", `refs/heads/${PARALLEL_BRANCH}*`),
  ]);
  const ownNames = [...folderNames(parallelRoot(projectPath)), ...(stateDir ? folderNames(path.join(stateDir, "parallel")) : [])];
  return planParallelCleanup(projectPath, parseWorktreeList(list), refs.split(/\r?\n/).map((b) => b.trim()).filter(Boolean), ownNames);
}

/** Removes a worktree's node_modules link, never what it points to (mirrors the engine's unlinkModules):
 *  `git worktree remove` follows the junction and would delete the project's own node_modules.
 *  Returns false when a link is still there, so the worktree must not be removed. */
export function unlinkModules(worktree: string): boolean {
  const link = path.join(worktree, "node_modules");
  const stat = () => { try { return lstatSync(link); } catch { return null; } };
  const before = stat();
  if (!before || !before.isSymbolicLink()) return true;
  try { unlinkSync(link); } catch { try { rmdirSync(link); } catch { /* checked below */ } }
  return stat() === null;
}

/** Removes every kept parallel worktree (node_modules link first) and this project's agent-dock/parallel-…
 *  branches (see planParallelCleanup), then prunes and removes the "-parallel" folder when it is empty.
 *  Unmerged work on them is lost. */
export async function cleanParallelWorktrees(projectPath: string, stateDir?: string): Promise<{ worktrees: number; branches: number; problems: string[] }> {
  const root = parallelRoot(projectPath), plan = await listParallelLeftovers(projectPath, stateDir), problems: string[] = [];
  let worktrees = 0, branches = 0;
  const realRoot = existsSync(root) ? realpathSync(root) : root;
  const skipped = new Set<string>();
  for (const w of plan.worktrees) {
    if (!isInside(root, w.path)) { problems.push(`${w.path} is outside ${root}; left alone.`); continue; }
    if (existsSync(w.path)) {
      // The folder itself must resolve inside the "-parallel" folder too (not be a link to somewhere else).
      if (!isInside(realRoot, realpathSync(w.path))) { problems.push(`${w.path} points outside ${root}; left alone.`); if (w.branch) skipped.add(w.branch); continue; }
      if (!unlinkModules(w.path)) { problems.push(`Could not remove the node_modules link in ${w.path}; left alone.`); if (w.branch) skipped.add(w.branch); continue; }
    }
    try { await git(projectPath, "worktree", "remove", "--force", w.path); worktrees++; }
    catch (error) {
      if (existsSync(w.path)) { problems.push((error as Error).message); if (w.branch) skipped.add(w.branch); continue; }
      worktrees++; // Already gone from disk: prune below drops git's record.
    }
  }
  await git(projectPath, "worktree", "prune").catch((error: Error) => { problems.push(error.message); });
  for (const branch of plan.branches) {
    if (skipped.has(branch) || !branch.startsWith(PARALLEL_BRANCH)) continue;
    try { await git(projectPath, "branch", "-D", branch); branches++; }
    catch (error) { problems.push((error as Error).message); }
  }
  try { if (existsSync(root) && readdirSync(root).length === 0) rmdirSync(root); } catch { /* left for you */ }
  return { worktrees, branches, problems };
}
