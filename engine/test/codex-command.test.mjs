import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { preflightCodex, resolveCodexCommand } from "../src/codex-command.mjs";

async function touch(file) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "");
}

test("Windows prefers the installed bundled codex.exe", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-command-"));
  try {
    const executable = path.join(root, "npm", "node_modules", "@openai", "codex", "node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe");
    await touch(executable);
    await touch(path.join(root, "npm", "codex.cmd"));

    const resolved = await resolveCodexCommand({
      platform: "win32",
      env: { APPDATA: root, PATH: path.join(root, "npm"), ComSpec: "C:\\Windows\\System32\\cmd.exe" },
    });

    assert.equal(resolved.command, executable);
    assert.equal(resolved.displayCommand, executable);
    assert.deepEqual(resolved.prefixArgs, []);
    assert.equal(resolved.source, "bundled-executable");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows falls back to codex.cmd from PATH using hidden cmd.exe", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-command-"));
  try {
    const commandFile = path.join(root, "codex.cmd");
    await touch(commandFile);
    const resolved = await resolveCodexCommand({
      platform: "win32",
      env: { PATH: root, ComSpec: "C:\\Windows\\System32\\cmd.exe" },
    });

    assert.equal(resolved.command, "C:\\Windows\\System32\\cmd.exe");
    assert.deepEqual(resolved.prefixArgs, ["/d", "/s", "/c", commandFile]);
    assert.equal(resolved.displayCommand, commandFile);
    assert.equal(resolved.source, "path-cmd");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("explicit CODEX_COMMAND override wins over installed launchers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-command-"));
  try {
    const override = path.join(root, "custom-codex.exe");
    const bundled = path.join(root, "npm", "node_modules", "@openai", "codex", "node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe");
    await touch(override);
    await touch(bundled);

    const resolved = await resolveCodexCommand({
      platform: "win32",
      env: { CODEX_COMMAND: override, APPDATA: root, PATH: "" },
    });

    assert.equal(resolved.command, override);
    assert.equal(resolved.displayCommand, override);
    assert.equal(resolved.source, "explicit");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing executable reports attempts, OS, PATH/npm context, and Get-Command guidance", async () => {
  await assert.rejects(
    resolveCodexCommand({
      platform: "win32",
      env: { PATH: "C:\\empty-one;C:\\empty-two", APPDATA: "C:\\missing-appdata", npm_config_prefix: "C:\\missing-npm" },
      fileExists: async () => false,
    }),
    (error) => {
      assert.match(error.message, /Attempted Codex commands:/);
      assert.match(error.message, /OS: win32/);
      assert.match(error.message, /PATH: C:\\empty-one;C:\\empty-two/);
      assert.match(error.message, /npm bin candidates:/);
      assert.match(error.message, /Get-Command codex -All/);
      return true;
    },
  );
});

test("preflight executes the resolved command and returns its version", async () => {
  const result = await preflightCodex({
    command: process.execPath,
    prefixArgs: [],
    displayCommand: process.execPath,
    source: "explicit",
  });
  assert.equal(result.command, process.execPath);
  assert.match(result.version, /^v\d+\./);
});
