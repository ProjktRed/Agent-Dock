import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkSandboxConfig, closeSandbox, toolchainDirs, useSandboxedChecks, useSandboxRuntime } from "../src/sandbox.mjs";
import { runShellCommand } from "../src/qa-packet.mjs";
import { runCheckCommand } from "../src/qa-runner.mjs";
import { configureProtection } from "../src/guard/protected-paths.mjs";

const temp = () => mkdtempSync(path.join(os.tmpdir(), "sandbox-test-"));

test("Linux check sandbox: home hidden (sign-ins too), only the worktree and its temp folder writable, no network", () => {
  const root = temp();
  mkdirSync(path.join(root, ".git"));
  const config = checkSandboxConfig({ cwd: root, tempDir: "/tmp/agent-dock-check-x", platform: "linux", home: "/home/u", env: { PATH: "" } });
  assert.deepEqual(config.network, { allowedDomains: [], deniedDomains: [] });
  assert.ok(config.filesystem.denyRead.includes("/home/u"));
  for (const secret of [".ssh", ".codex", ".claude", ".config/Agent Dock", ".npmrc"]) assert.ok(config.filesystem.denyRead.includes(path.join("/home/u", secret)), secret);
  assert.deepEqual(config.filesystem.allowWrite, [path.resolve(root), "/tmp/agent-dock-check-x"]);
  assert.ok(config.filesystem.allowRead.includes(path.resolve(root)));
  assert.deepEqual(config.filesystem.denyWrite, [path.join(path.resolve(root), ".git")]);
  assert.equal(config.windows, undefined);
});

test("Windows check sandbox: no deny stamps on your profile (the account cannot open it), the bundled srt-win, no network", () => {
  const root = temp();
  const config = checkSandboxConfig({ cwd: root, platform: "win32", home: "C:\\Users\\u", env: { Path: "" }, srtWinPath: "C:\\x\\srt-win.exe" });
  assert.deepEqual(config.filesystem.denyRead, []);
  assert.deepEqual(config.filesystem.allowWrite, [path.resolve(root)]);
  // No .git yet: no deny (srt would create a placeholder for a missing path).
  assert.deepEqual(config.filesystem.denyWrite, []);
  assert.deepEqual(config.network.allowedDomains, []);
  assert.equal(config.windows.srtWin.path, "C:\\x\\srt-win.exe");
});

test("a toolchain installed under home is let back in; machine-wide installs need nothing", () => {
  const home = temp();
  const windows = process.platform === "win32";
  // nvm on Linux: <prefix>/bin/node; a per-user Windows install: node.exe at the top of its folder.
  const prefix = path.join(home, ".nvm", "versions", "node", "v24");
  const bin = windows ? prefix : path.join(prefix, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, windows ? "node.exe" : "node"), "");
  const other = temp();
  assert.deepEqual(toolchainDirs({ env: { PATH: [other, bin].join(path.delimiter) }, home, platform: process.platform }), [prefix]);
  assert.deepEqual(toolchainDirs({ env: { PATH: other }, home, platform: process.platform }), []);
});

test("a sandbox that cannot start fails the check; it never runs unsandboxed", async () => {
  const root = temp();
  const marker = path.join(root, "ran.txt");
  useSandboxRuntime({ SandboxManager: { initialize: async () => { throw new Error("no sandbox here"); }, reset: async () => {} } });
  useSandboxedChecks(true);
  try {
    await assert.rejects(runShellCommand(`node -e "require('fs').writeFileSync('ran.txt','x')"`, root), /sandbox for checks could not start.*no sandbox here/);
    assert.throws(() => readFileSync(marker));
  } finally { useSandboxedChecks(false); useSandboxRuntime(null); }
});

test("both check runners spawn what the sandbox wraps, one check at a time, and release it afterwards", async () => {
  const root = temp();
  const stateDir = temp();
  execGitInit(root);
  configureProtection({ workspace: root, stateDir, paths: "[]" });
  const wrapped = [];
  let initialized = 0, active = 0, maxActive = 0;
  const shell = process.platform === "win32" ? ["cmd.exe", "/d", "/s", "/c"] : ["/bin/sh", "-c"];
  useSandboxRuntime({ SandboxManager: {
    initialize: async (config) => { initialized++; assert.deepEqual(config.network.allowedDomains, []); },
    reset: async () => {},
    cleanupAfterCommand: () => { active--; },
    wrapWithSandboxArgv: async (command) => {
      wrapped.push(command); active++; maxActive = Math.max(maxActive, active);
      return { argv: [...shell, "echo sandboxed"], env: { ...process.env } };
    },
  } });
  useSandboxedChecks(true);
  try {
    const [a, b] = await Promise.all([runShellCommand("npm test", root), runShellCommand("npm run lint", root)]);
    assert.match(a.stdout, /sandboxed/);
    assert.match(b.stdout, /sandboxed/);
    const c = await runCheckCommand("npm test", root, { stateDir });
    assert.match(c.output, /sandboxed/);
    assert.equal(wrapped.length, 3);
    assert.equal(initialized, 1, "one session per worktree");
    if (process.platform !== "win32") assert.equal(maxActive, 1, "checks wait for each other");
  } finally { await closeSandbox(); useSandboxedChecks(false); useSandboxRuntime(null); }
});

function execGitInit(dir) {
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: "node -e 0", lint: "node -e 0" } }));
}
