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

test("agents' commands sandboxed: Claude Code's sandbox fails closed with no network; Codex gets its elevated Windows sandbox", async () => {
  const { installProtection, CODEX_WINDOWS_SANDBOX } = await import("../src/guard/install-protection.mjs");
  const { useSandboxedAgents } = await import("../src/sandbox.mjs");
  const workspace = temp(), stateDir = temp(), invocation = temp();
  // A stand-in Claude Code that only answers --version.
  const fake = path.join(temp(), "fake-claude.mjs");
  const launcher = (version = "2.1.296") => { writeFileSync(fake, `console.log("${version} (Claude Code)")`); return { command: process.execPath, prefixArgs: [fake] }; };
  const claudeSettings = async (l = launcher()) => JSON.parse((await installProtection({ cli: "claude", workspace, stateDir, invocation, launcher: l }))[1]);
  try {
    assert.equal((await claudeSettings()).sandbox, undefined);
    assert.ok(!(await installProtection({ cli: "codex", workspace, stateDir, invocation })).includes('windows.sandbox="elevated"'));
    useSandboxedAgents(true);
    writeFileSync(path.join(workspace, ".env"), "SECRET=x");
    if (process.platform === "win32") {
      // Claude Code's sandbox doesn't run on native Windows: every Claude run refuses, saying why.
      await assert.rejects(claudeSettings(), /native Windows.*WSL2/);
      const codex = await installProtection({ cli: "codex", workspace, stateDir, invocation });
      assert.deepEqual(codex.slice(codex.indexOf(CODEX_WINDOWS_SANDBOX[1]) - 1, codex.indexOf(CODEX_WINDOWS_SANDBOX[1]) + 1), [...CODEX_WINDOWS_SANDBOX]);
      return;
    }
    await assert.rejects(claudeSettings(launcher("2.1.100")), /too old/);
    await assert.rejects(installProtection({ cli: "claude", workspace, stateDir, invocation }), /could not be read/, "no CLI to ask: refused");
    const sandbox = (await claudeSettings()).sandbox;
    assert.deepEqual({ ...sandbox, filesystem: undefined, credentials: undefined }, { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, network: { allowedDomains: [] }, filesystem: undefined, credentials: undefined });
    // Guard plan 0c: commands can't read or write the protected paths, nor read your sign-ins.
    assert.ok(sandbox.filesystem.denyRead.includes(path.resolve(stateDir)), "Agent Dock's state");
    assert.ok(sandbox.filesystem.denyWrite.filter((p) => path.basename(p) !== ".git").every((p) => sandbox.filesystem.denyRead.includes(p)), "nothing it can't write stays readable, except Git's folder");
    assert.ok(sandbox.filesystem.denyWrite.includes(path.resolve(stateDir)));
    assert.ok(!sandbox.filesystem.denyRead.includes(path.join(path.resolve(workspace), ".git")), "a missing path is not listed");
    assert.ok(sandbox.credentials.files.every((f) => f.mode === "deny"));
    const codex = await installProtection({ cli: "codex", workspace, stateDir, invocation });
    if (process.platform === "win32") assert.deepEqual(codex.slice(codex.indexOf(CODEX_WINDOWS_SANDBOX[1]) - 1, codex.indexOf(CODEX_WINDOWS_SANDBOX[1]) + 1), [...CODEX_WINDOWS_SANDBOX]);
    else assert.ok(!codex.includes('windows.sandbox="elevated"'));
  } finally { useSandboxedAgents(false); }
});

test("Windows: a Codex whose elevated sandbox is not set up fails its preflight while agents are sandboxed", { skip: process.platform !== "win32" }, async () => {
  const { preflightCodex } = await import("../src/codex-command.mjs");
  const { useSandboxedAgents } = await import("../src/sandbox.mjs");
  const dir = temp(), script = path.join(dir, "fake-codex.mjs");
  writeFileSync(script, `const a=process.argv.slice(2);if(a.includes("--version"))console.log("codex-cli 0.0.0");else{console.log("  sandbox backend          unelevated");console.log("  sandbox provisioning     complete");}`);
  const launcher = { command: process.execPath, prefixArgs: [script], displayCommand: `fake-${Date.now()}` };
  assert.equal((await preflightCodex(launcher)).version, "codex-cli 0.0.0");
  useSandboxedAgents(true);
  try { await assert.rejects(preflightCodex(launcher), /elevated Windows sandbox is not set up/); }
  finally { useSandboxedAgents(false); }
});

test("a sandboxed Claude run needs a recent enough CLI and refuses on native Windows, saying why (0c)", async () => {
  const { claudeSandboxProblem, claudeSandbox } = await import("../src/guard/adapters/claude.mjs");
  assert.match(claudeSandboxProblem({ platform: "win32", version: "2.1.296 (Claude Code)" }), /native Windows.*WSL2/);
  assert.equal(claudeSandboxProblem({ platform: "linux", version: "2.1.296 (Claude Code)" }), null);
  assert.equal(claudeSandboxProblem({ platform: "linux", version: "3.0.0" }), null);
  assert.match(claudeSandboxProblem({ platform: "linux", version: "2.1.99 (Claude Code)" }), /too old.*2\.1\.221/);
  assert.match(claudeSandboxProblem({ platform: "linux", version: null }), /could not be read/);
  const home = temp(), workspace = temp();
  mkdirSync(path.join(home, ".ssh")); writeFileSync(path.join(home, ".git-credentials"), "x"); mkdirSync(path.join(workspace, ".git"));
  const config = claudeSandbox({ workspace, protectedPaths: [".git/", ".env*"], homeSecrets: [".ssh", ".aws", ".git-credentials"], home });
  assert.deepEqual(config.filesystem.denyRead, [path.join(home, ".ssh"), path.join(home, ".git-credentials"), path.join(workspace, ".env*")]);
  assert.ok(config.filesystem.denyWrite.includes(path.join(workspace, ".git")), "Git can read its folder but not write it");
  assert.deepEqual(config.credentials.files, [{ path: path.join(home, ".git-credentials"), mode: "deny" }]);
  assert.ok(!claudeSandbox({ workspace, protectedPaths: [".git/"], home, allowGitCommit: true }).filesystem.denyWrite.includes(path.join(workspace, ".git")), "a committing task keeps Git writable");
});
