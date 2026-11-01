import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { compareUrl, ensureRunBranch, githubRepo, gitlabRepo, newMergeRequestUrl, openPullRequest, runBranchName } from "../src/main/lib/pull-request";

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

  it("reads GitLab remotes and builds the new merge request page", () => {
    expect(["https://gitlab.com/group/sub/app.git", "git@gitlab.com:group/app.git", "ssh://git@gitlab.example.org:2222/team/app", "https://github.com/o/r", "https://example.com/o/r.git"].map(gitlabRepo))
      .toEqual([{ host: "gitlab.com", path: "group/sub/app" }, { host: "gitlab.com", path: "group/app" }, { host: "gitlab.example.org", path: "team/app" }, null, null]);
    expect(newMergeRequestUrl({ host: "gitlab.com", path: "g/app" }, "main", "agent-dock/run-1"))
      .toBe("https://gitlab.com/g/app/-/merge_requests/new?merge_request%5Bsource_branch%5D=agent-dock%2Frun-1&merge_request%5Btarget_branch%5D=main");
  });

  it("on GitLab, a server without push options still gets the branch, and the new merge request page", async () => {
    const dir = repo();
    await ensureRunBranch(dir, null, new Date(2026, 9, 21, 9, 5));
    writeFileSync(path.join(dir, "b.txt"), "b"); git(dir, "add", "."); git(dir, "commit", "-qm", "task");
    const bare = mkdtempSync(path.join(os.tmpdir(), "mr-remote-"));
    git(bare, "init", "-q", "--bare");
    git(dir, "remote", "add", "origin", "https://gitlab.com/team/app.git");
    // Pushes go to the local bare repository; the remote still reads as GitLab.
    git(dir, "config", `url.${bare.replaceAll("\\", "/")}.pushInsteadOf`, "https://gitlab.com/team/app.git");
    const result = await openPullRequest(dir, "main", "Build it", "body", null);
    expect(result).toMatchObject({ created: false, branch: "agent-dock/run-20261021-0905", repo: null });
    expect(result.url).toBe(newMergeRequestUrl({ host: "gitlab.com", path: "team/app" }, "main", "agent-dock/run-20261021-0905"));
    expect(git(bare, "rev-parse", "agent-dock/run-20261021-0905")).toBe(result.sha);
  });
});
