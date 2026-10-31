import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertSafeRepository, safeGitArgs, unsafeRepoConfig, unsafeConfigEntries } from "../src/git-safe.mjs";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
function repo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "git-safe-"));
  git(dir, "init", "-q"); git(dir, "config", "user.name", "T"); git(dir, "config", "user.email", "t@example.invalid");
  writeFileSync(path.join(dir, "a.txt"), "a\n"); git(dir, "add", "a.txt"); git(dir, "commit", "-qm", "base");
  return dir;
}

test("every git call turns off repository-run programs; diff, show and log also skip external diff and textconv", () => {
  assert.deepEqual(safeGitArgs(["status", "--porcelain"]).slice(-2), ["status", "--porcelain"]);
  const args = safeGitArgs(["-c", "core.fsmonitor=false", "diff", "--cached"]);
  assert.deepEqual(args, ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "protocol.file.allow=user", "diff", "--no-ext-diff", "--no-textconv", "--cached"]);
  assert.ok(safeGitArgs(["log", "-1"]).includes("--no-textconv"));
});

test("a hook, an fsmonitor program and an external diff the repository sets up never run", () => {
  const dir = repo(), marker = path.join(dir, "ran.txt");
  const script = path.join(dir, "evil.sh");
  writeFileSync(script, `#!/bin/sh\necho ran > "${marker.replaceAll("\\", "/")}"\n`); chmodSync(script, 0o755);
  mkdirSync(path.join(dir, "hooks"));
  writeFileSync(path.join(dir, "hooks", "pre-commit"), `#!/bin/sh\necho ran > "${marker.replaceAll("\\", "/")}"\n`); chmodSync(path.join(dir, "hooks", "pre-commit"), 0o755);
  git(dir, "config", "core.hooksPath", "hooks");
  git(dir, "config", "core.fsmonitor", script.replaceAll("\\", "/"));
  git(dir, "config", "diff.external", script.replaceAll("\\", "/"));
  writeFileSync(path.join(dir, "a.txt"), "b\n");
  execFileSync("git", safeGitArgs(["diff"]), { cwd: dir, windowsHide: true });
  execFileSync("git", safeGitArgs(["status", "--porcelain"]), { cwd: dir, windowsHide: true });
  execFileSync("git", safeGitArgs(["commit", "-qam", "x"]), { cwd: dir, windowsHide: true });
  assert.equal(existsSync(marker), false);
});

test("repository config that would run a program is refused; husky's hooksPath and Git LFS are fine", async () => {
  const dir = repo();
  git(dir, "config", "core.hooksPath", ".husky/_");
  git(dir, "config", "filter.lfs.clean", "git-lfs clean -- %f");
  git(dir, "config", "filter.lfs.smudge", "git-lfs smudge -- %f");
  git(dir, "config", "filter.lfs.process", "git-lfs filter-process");
  git(dir, "config", "commit.gpgSign", "false");
  assert.deepEqual(await unsafeRepoConfig(dir), []);
  await assertSafeRepository(dir);
  for (const [key, value] of [["filter.evil.smudge", "evil"], ["credential.helper", "!evil"], ["core.sshCommand", "evil"], ["merge.x.driver", "evil %A"], ["gpg.program", "evil"], ["remote.origin.uploadpack", "evil"], ["include.path", "../elsewhere"], ["filter.lfs.smudge", "evil"], ["commit.gpgSign", "true"], ["gpg.ssh.defaultKeyCommand", "evil"]]) {
    const d = repo();
    git(d, "config", key, value);
    assert.deepEqual((await unsafeRepoConfig(d)).map((l) => l.split("=")[0]), [key.toLowerCase()], key);
    await assert.rejects(assertSafeRepository(d), /runs programs/, key);
  }
});

test("a .git that redirects to another repository is refused; a registered linked worktree is fine", async () => {
  const main = repo();
  const linked = path.join(mkdtempSync(path.join(os.tmpdir(), "git-safe-wt-")), "wt");
  git(main, "worktree", "add", "-q", linked);
  await assertSafeRepository(linked);
  const other = repo(), victim = mkdtempSync(path.join(os.tmpdir(), "git-safe-redirect-"));
  writeFileSync(path.join(victim, ".git"), `gitdir: ${path.join(other, ".git").replaceAll("\\", "/")}\n`);
  await assert.rejects(assertSafeRepository(victim), /not a worktree its repository registered/);
});

test("a git that ends config keys with CRLF still has its programs found (release review 0.40.0)", () => {
  const out = ["local", "credential.helper\r\n!echo x", "local", "merge.evil.driver\r\nrun %A", "local", "user.name\r\nMe", "global", "core.sshcommand\r\nssh"].join("\0") + "\0";
  assert.deepEqual(unsafeConfigEntries(out).map((e) => e.split("=")[0]), ["credential.helper", "merge.evil.driver"]);
});
