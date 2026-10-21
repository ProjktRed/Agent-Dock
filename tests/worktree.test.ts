import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { addLaneWorktree, lanePath, laneSlug, mergeLaneBranch, removeLaneWorktree } from "../src/main/lib/worktree";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

describe("parallel lanes", () => {
  it("adds a worktree lane on its own branch and removes it, keeping the branch", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "lanes-"));
    const project = path.join(dir, "app");
    execFileSync("git", ["init", "-q", "-b", "main", project]);
    git(project, "config", "user.email", "t@t.invalid"); git(project, "config", "user.name", "t");
    writeFileSync(path.join(project, "a.txt"), "a"); git(project, "add", "."); git(project, "commit", "-qm", "init");
    expect(laneSlug("  Docs & Tests! ")).toBe("docs-tests");
    const lane = await addLaneWorktree(project, "Docs & Tests");
    expect(lane).toEqual({ path: lanePath(project, "docs-tests"), branch: "agent-dock/lane-docs-tests", slug: "docs-tests" });
    expect(git(lane.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("agent-dock/lane-docs-tests");
    await expect(addLaneWorktree(project, "docs tests")).rejects.toThrow(/already exists/);
    await expect(addLaneWorktree(project, "!!!")).rejects.toThrow(/letters or digits/);
    writeFileSync(path.join(lane.path, "wip.txt"), "x");
    await expect(removeLaneWorktree(project, lane.path)).rejects.toThrow(/worktree remove/);
    await removeLaneWorktree(project, lane.path, true);
    expect(existsSync(lane.path)).toBe(false);
    expect(git(project, "branch", "--list", "agent-dock/*")).toContain("agent-dock/lane-docs-tests");
  });

  it("merges a lane as one merge commit, and a conflict merges nothing", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "lanes-merge-"));
    const project = path.join(dir, "app");
    execFileSync("git", ["init", "-q", "-b", "main", project]);
    git(project, "config", "user.email", "t@t.invalid"); git(project, "config", "user.name", "t");
    writeFileSync(path.join(project, "a.txt"), "a\n"); git(project, "add", "."); git(project, "commit", "-qm", "init");
    const lane = await addLaneWorktree(project, "docs");
    await expect(mergeLaneBranch(project, lane.path, lane.branch, "docs")).rejects.toThrow(/no commits/);
    writeFileSync(path.join(lane.path, "b.txt"), "b"); git(lane.path, "add", "."); git(lane.path, "commit", "-qm", "lane work");
    writeFileSync(path.join(lane.path, "wip.txt"), "x");
    await expect(mergeLaneBranch(project, lane.path, lane.branch, "docs")).rejects.toThrow(/lane has uncommitted/);
    git(lane.path, "clean", "-fdq");
    writeFileSync(path.join(project, "dirty.txt"), "x");
    await expect(mergeLaneBranch(project, lane.path, lane.branch, "docs")).rejects.toThrow(/project has uncommitted changes on main/);
    git(project, "clean", "-fdq");
    const merged = await mergeLaneBranch(project, lane.path, lane.branch, "docs");
    expect(merged).toMatchObject({ into: "main", commits: 1 });
    const [subject, parents] = git(project, "log", "-1", "--format=%s%n%P").split("\n");
    expect(subject).toBe("Merge lane docs (agent-dock/lane-docs)");
    expect(parents.split(" ")).toHaveLength(2);
    expect(existsSync(path.join(project, "b.txt"))).toBe(true);

    const other = await addLaneWorktree(project, "clash");
    writeFileSync(path.join(other.path, "a.txt"), "lane\n"); git(other.path, "commit", "-qam", "lane a");
    writeFileSync(path.join(project, "a.txt"), "main\n"); git(project, "commit", "-qam", "main a");
    const head = git(project, "rev-parse", "HEAD");
    await expect(mergeLaneBranch(project, other.path, other.branch, "clash")).rejects.toThrow(/conflicts with main in a\.txt\. Nothing was merged/);
    expect(git(project, "rev-parse", "HEAD")).toBe(head);
    expect(git(project, "status", "--porcelain")).toBe("");
  });
});
