import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cleanParallelWorktrees, isInside, listParallelLeftovers, parallelRoot, parseWorktreeList, planParallelCleanup } from "../src/main/lib/worktree";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

describe("parallel worktree cleanup helpers", () => {
  const project = path.resolve("/work/app");
  it("only counts paths strictly inside the -parallel folder", () => {
    const root = parallelRoot(project);
    expect(root).toBe(path.resolve("/work/app-parallel"));
    expect(isInside(root, path.join(root, "t1-abc"))).toBe(true);
    expect(isInside(root, root)).toBe(false);
    expect(isInside(root, path.resolve("/work/app-parallel2/t1"))).toBe(false);
    expect(isInside(root, path.join(root, "..", "app"))).toBe(false);
  });
  it("plans kept worktrees and loose parallel branches only", () => {
    const list = parseWorktreeList([
      `worktree ${project.replaceAll("\\", "/")}`, "HEAD 1", "branch refs/heads/main", "",
      `worktree ${path.resolve("/work/app-parallel/t1-abc").replaceAll("\\", "/")}`, "HEAD 2", "branch refs/heads/agent-dock/parallel-t1-abc", "",
      `worktree ${path.resolve("/work/app-lanes/docs")}`, "HEAD 3", "branch refs/heads/agent-dock/parallel-mine", "",
      `worktree ${path.resolve("/work/app-parallel/t2-abc")}`, "HEAD 4", "detached", "",
    ].join("\n"));
    const plan = planParallelCleanup(project, list, ["agent-dock/parallel-t1-abc", "agent-dock/parallel-mine", "agent-dock/parallel-old", "agent-dock/parallel-t2-abc", "agent-dock/parallel-", "feature"], ["old", "mine"]);
    expect(plan.worktrees).toEqual([{ path: path.resolve("/work/app-parallel/t1-abc"), branch: "agent-dock/parallel-t1-abc" }, { path: path.resolve("/work/app-parallel/t2-abc"), branch: null }]);
    // "old" is a folder this project used; t2-abc's worktree is listed inside its -parallel folder.
    expect(plan.branches).toEqual(["agent-dock/parallel-t1-abc", "agent-dock/parallel-old", "agent-dock/parallel-t2-abc"]);
  });
  it("leaves loose parallel branches of other projects and lanes alone", () => {
    const list = parseWorktreeList([
      `worktree ${project}`, "HEAD 1", "branch refs/heads/main", "",
      `worktree ${path.resolve("/work/app-lanes/docs")}`, "HEAD 2", "branch refs/heads/agent-dock/lane-docs", "",
      `worktree ${path.resolve("/work/app-lanes/docs-parallel/l1-abc")}`, "HEAD 3", "branch refs/heads/agent-dock/parallel-l1-abc", "prunable gitdir file points to non-existent location", "",
    ].join("\n"));
    const branches = ["agent-dock/parallel-l1-abc", "agent-dock/parallel-l2-abc", "agent-dock/parallel-p1-abc"];
    // The parent sees neither lane branch as its own, nor one whose folder it never had.
    expect(planParallelCleanup(project, list, branches, ["p1-abc"]).branches).toEqual(["agent-dock/parallel-p1-abc"]);
    expect(planParallelCleanup(project, list, branches).branches).toEqual([]);
    // The lane takes its listed (prunable) worktree's branch and the ones it knows, never the parent's.
    const lane = planParallelCleanup(path.resolve("/work/app-lanes/docs"), list, branches, ["l2-abc"]);
    expect(lane.worktrees).toEqual([{ path: path.resolve("/work/app-lanes/docs-parallel/l1-abc"), branch: "agent-dock/parallel-l1-abc" }]);
    expect(lane.branches).toEqual(["agent-dock/parallel-l1-abc", "agent-dock/parallel-l2-abc"]);
  });
});

describe("cleanParallelWorktrees", () => {
  it("removes kept parallel worktrees and branches without touching the project's node_modules", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "parallel-clean-"));
    const project = path.join(dir, "app");
    execFileSync("git", ["init", "-q", "-b", "main", project]);
    git(project, "config", "user.email", "t@t.invalid"); git(project, "config", "user.name", "t");
    writeFileSync(path.join(project, ".gitignore"), "node_modules/\n");
    writeFileSync(path.join(project, "a.txt"), "a"); git(project, "add", "."); git(project, "commit", "-qm", "init");
    const modules = path.join(project, "node_modules", "dep");
    mkdirSync(modules, { recursive: true });
    writeFileSync(path.join(modules, "index.js"), "keep me");

    // Two kept tasks, as the engine leaves them: a worktree with a node_modules junction to the project's.
    const root = path.join(dir, "app-parallel");
    for (const name of ["t1-abc", "t2-abc"]) {
      const worktree = path.join(root, name);
      git(project, "worktree", "add", "-q", "-b", `agent-dock/parallel-${name}`, worktree, "HEAD");
      symlinkSync(path.join(project, "node_modules"), path.join(worktree, "node_modules"), "junction");
      writeFileSync(path.join(worktree, "wip.txt"), "unmerged");
    }
    expect(readFileSync(path.join(root, "t1-abc", "node_modules", "dep", "index.js"), "utf8")).toBe("keep me");
    // A task whose worktree folder is gone but git still lists (prunable), and a merged task's branch whose
    // worktree git no longer knows, recorded only in the project's state folder.
    git(project, "worktree", "add", "-q", "-b", "agent-dock/parallel-gone-abc", path.join(root, "gone-abc"), "HEAD");
    rmSync(path.join(root, "gone-abc"), { recursive: true, force: true });
    const stateDir = path.join(dir, "state", "app");
    mkdirSync(path.join(stateDir, "parallel", "old-abc"), { recursive: true });
    git(project, "branch", "agent-dock/parallel-old-abc");
    // Things that must stay: other branches, a lane, a parallel branch checked out elsewhere, and loose
    // parallel branches of the lane's runs and of a project this one never ran.
    git(project, "branch", "feature");
    const lane = path.join(dir, "app-lanes", "docs");
    git(project, "worktree", "add", "-q", "-b", "agent-dock/lane-docs", lane, "HEAD");
    const outside = path.join(dir, "elsewhere");
    git(project, "worktree", "add", "-q", "-b", "agent-dock/parallel-mine", outside, "HEAD");
    git(project, "branch", "agent-dock/parallel-lane1-abc");
    git(project, "branch", "agent-dock/parallel-other-xyz");
    const laneState = path.join(dir, "state", "lane");
    mkdirSync(path.join(laneState, "parallel", "lane1-abc"), { recursive: true });

    const before = await listParallelLeftovers(project, stateDir);
    expect(before.worktrees.map((w) => path.basename(w.path)).sort()).toEqual(["gone-abc", "t1-abc", "t2-abc"]);
    expect(before.branches.sort()).toEqual(["agent-dock/parallel-gone-abc", "agent-dock/parallel-old-abc", "agent-dock/parallel-t1-abc", "agent-dock/parallel-t2-abc"]);
    // Cleaning from the lane touches only the lane's own loose branch.
    expect(await listParallelLeftovers(lane, laneState)).toEqual({ worktrees: [], branches: ["agent-dock/parallel-lane1-abc"] });
    expect((await listParallelLeftovers(lane)).branches).toEqual([]);

    const result = await cleanParallelWorktrees(project, stateDir);
    expect(result).toEqual({ worktrees: 3, branches: 4, problems: [] });
    expect(readFileSync(path.join(modules, "index.js"), "utf8")).toBe("keep me");
    expect(existsSync(root)).toBe(false);
    const branches = git(project, "branch", "--format=%(refname:short)").split(/\r?\n/).sort();
    expect(branches).toEqual(["agent-dock/lane-docs", "agent-dock/parallel-lane1-abc", "agent-dock/parallel-mine", "agent-dock/parallel-other-xyz", "feature", "main"]);
    const worktrees = parseWorktreeList(git(project, "worktree", "list", "--porcelain")).map((w) => w.path);
    expect(worktrees).toEqual([project, lane, outside].map((p) => path.resolve(p)));
    expect(existsSync(lane) && existsSync(outside)).toBe(true);
    expect(await listParallelLeftovers(project, stateDir)).toEqual({ worktrees: [], branches: [] });
  });
});
