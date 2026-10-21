import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { addLaneWorktree, lanePath, laneSlug, removeLaneWorktree } from "../src/main/lib/worktree";

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
});
