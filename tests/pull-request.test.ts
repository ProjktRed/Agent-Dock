import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { compareUrl, ensureRunBranch, githubRepo, openPullRequest, runBranchName } from "../src/main/lib/pull-request";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
function repo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pr-mode-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@t.invalid"); git(dir, "config", "user.name", "t");
  writeFileSync(path.join(dir, "a.txt"), "a"); git(dir, "add", "."); git(dir, "commit", "-qm", "init");
  return dir;
}

describe("pull-request mode", () => {
  it("names run branches and reads GitHub remotes", () => {
    expect(runBranchName(new Date(2026, 9, 19, 2, 31))).toBe("agent-dock/run-20261019-0231");
    expect(["https://github.com/ProjktRed/Agent-Dock.git", "git@github.com:ProjktRed/Agent-Dock.git", "ssh://git@github.com/ProjktRed/Agent-Dock", "https://gitlab.com/a/b.git"].map(githubRepo))
      .toEqual(["ProjktRed/Agent-Dock", "ProjktRed/Agent-Dock", "ProjktRed/Agent-Dock", null]);
    expect(compareUrl("o/r", "main", "agent-dock/run-1")).toBe("https://github.com/o/r/compare/main...agent-dock%2Frun-1?expand=1");
  });

  it("creates a run branch once, keeps it on later starts, and pushes only when asked", async () => {
    const dir = repo();
    const first = await ensureRunBranch(dir, null, new Date(2026, 9, 19, 2, 31));
    expect(first).toEqual({ branch: "agent-dock/run-20261019-0231", base: "main", created: true });
    expect(await ensureRunBranch(dir, "main")).toEqual({ branch: first.branch, base: "main", created: false });
    await expect(openPullRequest(dir, "main", "t", "b", null)).rejects.toThrow(/no commits/);
    writeFileSync(path.join(dir, "b.txt"), "b"); git(dir, "add", "."); git(dir, "commit", "-qm", "task");
    const bare = mkdtempSync(path.join(os.tmpdir(), "pr-remote-"));
    git(bare, "init", "-q", "--bare");
    git(dir, "remote", "add", "origin", bare);
    await expect(openPullRequest(dir, "main", "t", "b", null)).rejects.toThrow(/Pushed agent-dock\/run-20261019-0231.*not on GitHub/);
    expect(git(bare, "branch", "--list", "agent-dock/*")).toContain("agent-dock/run-20261019-0231");
  });
});
