import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { askable, askUser, definitelyRefused, hookTimeoutSeconds } from "../src/guard/ask.mjs";
import { runHook } from "../src/guard/hook-runner.mjs";
import codex from "../src/guard/adapters/codex.mjs";
import claude from "../src/guard/adapters/claude.mjs";
import { protectedPathsFor } from "../src/guard/protected-paths.mjs";

const temp = () => mkdtempSync(path.join(os.tmpdir(), "guard-ask-"));
function setup(minutes = 0.02) {
  const workspace = temp(), stateDir = temp(), dir = path.join(stateDir, "approvals");
  writeFileSync(path.join(workspace, ".env"), "SECRET=x");
  const policy = { workspace, protectedPaths: protectedPathsFor({ workspace, stateDir }), allowedPaths: [], qaCommand: "", toolGuard: false, allowGitCommit: false, protectionOnly: true, ask: { dir, timeoutMs: minutes * 60_000 } };
  const policyPath = path.join(stateDir, "policy.json"), logPath = path.join(stateDir, "log.ndjson");
  writeFileSync(policyPath, JSON.stringify(policy));
  return { workspace, stateDir, dir, policy, policyPath, logPath };
}
const bash = (command, cwd) => JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd });

/** Answers the first request that appears, as the app would. */
function answerWhenAsked(dir, decision) {
  const timer = setInterval(() => {
    let files = [];
    try { files = readdirSync(dir).filter((f) => f.endsWith(".request.json")); } catch { return; }
    if (!files.length) return;
    const request = JSON.parse(readFileSync(path.join(dir, files[0]), "utf8"));
    writeFileSync(path.join(dir, `${request.id}.decision.json`), JSON.stringify({ id: request.id, decision }));
    clearInterval(timer);
  }, 20);
  return () => clearInterval(timer);
}

test("only unverified actions are askable: protected paths and edits stay refused outright", () => {
  const { policy, workspace } = setup();
  const command = (text) => ({ kind: "command", tool: "Bash", commands: [text], cwd: workspace });
  assert.equal(definitelyRefused(policy, command("cat .env")), true);
  assert.equal(definitelyRefused(policy, command(`type "${path.join(workspace, ".env")}"`)), true);
  assert.equal(definitelyRefused(policy, command(`cd "${workspace}" && git ls-files | head -40`)), false);
  assert.equal(definitelyRefused(policy, command("rg --files -g '!.git'")), false);
  assert.equal(definitelyRefused(policy, { kind: "unknown", tool: "webrun", input: { url: "https://example.com" }, cwd: workspace }), false);
  assert.equal(definitelyRefused(policy, { kind: "unknown", tool: "x", input: { path: ".env" }, cwd: workspace }), true);
  assert.equal(definitelyRefused(policy, { kind: "edit", tool: "Edit", input: {}, paths: ["a.txt"], cwd: workspace }), true);
  const stop = { effect: "stop", reason: "r" };
  assert.equal(askable(policy, command("rg --files"), stop, codex), true);
  assert.equal(askable(policy, command("rg --files"), stop, { id: "cline" }), false, "Cline's guard cannot wait");
  assert.equal(askable({ ...policy, ask: null }, command("rg --files"), stop, codex), false);
  assert.equal(askable(policy, command("rg --files"), { effect: "allow" }, codex), false);
});

test("code inside a command is asked about, not refused as if it named a protected path", () => {
  const { policy, workspace, stateDir } = setup();
  const command = (text) => ({ kind: "command", tool: "Bash", commands: [text], cwd: workspace });
  // The icon writer an agent used: `c>>>1):c>>>1`, `raw[o]=e?240:40` and `icons',{recursive:true}` are code.
  const iconWriter = `node -e "const fs=require('fs');for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;raw[o]=e?240:40;fs.mkdirSync('src-tauri/icons',{recursive:true})"`;
  assert.equal(definitelyRefused(policy, command(iconWriter)), false);
  // Protected names hidden in the same punctuation, or behind a variable, stay refused outright.
  assert.equal(definitelyRefused(policy, command("Get-Content -Path:.env")), true);
  assert.equal(definitelyRefused(policy, command(`node -e "require('fs').readFileSync('.env')"`)), true);
  assert.equal(definitelyRefused(policy, command("x=.env cat")), true);
  process.env.GUARD_ASK_TEST_STATE = stateDir;
  try {
    assert.equal(definitelyRefused(policy, command("type $env:GUARD_ASK_TEST_STATE\\policy.json")), true);
    assert.equal(definitelyRefused(policy, command("cat %GUARD_ASK_TEST_STATE%/policy.json")), true);
    assert.equal(definitelyRefused(policy, command("Get-Content ${env:GUARD_ASK_TEST_STATE}\\policy.json")), true);
    assert.equal(definitelyRefused(policy, command(`Get-Content -Path:${path.join(stateDir, "policy.json")}`)), true);
    assert.equal(definitelyRefused(policy, command(`cat "${stateDir}${path.sep}policy.json"`)), true);
  } finally { delete process.env.GUARD_ASK_TEST_STATE; }
});

test("an unverified command runs once you allow it, and stays refused when you refuse it or do not answer", async () => {
  for (const [decision, exitCode, reason] of [["allow", 0, null], ["deny", 2, /you refused it/], [null, 2, /no answer in time/]]) {
    const { dir, policyPath, logPath, workspace } = setup();
    const stop = decision ? answerWhenAsked(dir, decision) : () => {};
    try {
      const result = await runHook(codex, { policyPath, logPath, input: bash("rg --files", workspace) });
      assert.equal(result.exitCode, exitCode, String(decision));
      if (reason) assert.match(result.stderr, reason);
      const log = JSON.parse(readFileSync(logPath, "utf8").trim().split("\n").at(-1));
      assert.equal(log.asked, decision ?? "timeout");
      assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".request.json")), [], "the request is withdrawn once answered or expired");
    } finally { stop(); }
  }
});

test("a command naming a protected file is refused at once, with no question", async () => {
  const { dir, policyPath, logPath, workspace } = setup();
  const result = await runHook(claude, { policyPath, logPath, input: bash("cat .env", workspace) });
  assert.match(JSON.stringify(result), /Protected-path policy refused/);
  assert.throws(() => readdirSync(dir));
});

test("the request carries what you need to decide, never more than 2000 characters of command", async () => {
  const { policy, workspace } = setup(0.005);
  let seen = null;
  const sleep = async () => { if (!seen) { const f = readdirSync(policy.ask.dir).find((x) => x.endsWith(".request.json")); if (f) seen = JSON.parse(readFileSync(path.join(policy.ask.dir, f), "utf8")); } await new Promise((r) => setTimeout(r, 5)); };
  assert.equal(await askUser(policy, { kind: "command", tool: "Bash", commands: ["x".repeat(5000)], cwd: workspace }, "unverified", codex, { sleep }), "timeout");
  assert.equal(seen.cli, "Codex");
  assert.equal(seen.text.length, 2000);
  assert.match(seen.id, /^[0-9a-f]{32}$/);
  assert.ok(Date.parse(seen.expiresAt) > Date.parse(seen.createdAt));
  assert.equal(hookTimeoutSeconds({ timeoutMs: 600_000 }), 630);
  assert.equal(hookTimeoutSeconds(null), 30);
});

test("Allow for this run: the same action is allowed without asking until the run ends; anything different still asks", async () => {
  const { dir, policyPath, logPath, workspace, policy } = setup();
  const run = async (command) => {
    const result = await runHook(codex, { policyPath, logPath, input: bash(command, workspace) });
    return { exitCode: result.exitCode, asked: JSON.parse(readFileSync(logPath, "utf8").trim().split("\n").at(-1)).asked };
  };
  try {
    // The app's "Allow for this run" button writes the decision with remember: true.
    const remember = setInterval(() => {
      for (const f of (() => { try { return readdirSync(dir); } catch { return []; } })().filter((x) => x.endsWith(".request.json"))) {
        const r = JSON.parse(readFileSync(path.join(dir, f), "utf8"));
        try { writeFileSync(path.join(dir, `${r.id}.decision.json`), JSON.stringify({ id: r.id, decision: "allow", remember: true }), { flag: "wx" }); } catch { /* answered */ }
      }
    }, 20);
    try { assert.deepEqual(await run("rg --files"), { exitCode: 0, asked: "allow-run" }); } finally { clearInterval(remember); }
    assert.deepEqual(await run("rg --files"), { exitCode: 0, asked: "remembered" });
    assert.deepEqual(await run("git ls-files | head -5"), { exitCode: 2, asked: "timeout" }, "a different command asks again");
    const { useActionAsk, startAskRun } = await import("../src/guard/ask.mjs");
    useActionAsk({ stateDir: path.dirname(dir), minutes: 1 });
    await startAskRun();
    useActionAsk({});
    assert.deepEqual(await run("rg --files"), { exitCode: 2, asked: "timeout" }, "a new run forgets it");
    // A remembered entry never covers a protected path: those are refused before the list is read.
    mkdirSync(path.join(dir, "allowed-for-run"), { recursive: true });
    assert.match(JSON.stringify(await runHook(codex, { policyPath, logPath, input: bash("cat .env", workspace) })), /Protected-path policy refused/);
    assert.equal(policy.ask.dir, dir);
  } finally { /* nothing left running */ }
});
