import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installProtection, codexTtyCheck, claudeScrubProblem, CODEX_NO_TTY, resetCodexTtyChecks } from "../src/guard/install-protection.mjs";
import { claudeRunEnvironment, claudeSandboxFailure, extractClaudeResult } from "../src/claude-worker.mjs";

const temp = () => mkdtempSync(path.join(os.tmpdir(), "run-start-"));
const fakeCodex = fileURLToPath(new URL("../fixtures/fake-codex-process.mjs", import.meta.url));

test("Codex runs without terminals, so it can't type into a running command; a Codex that keeps them on is refused (kadono 0.40.1 probe)", async (t) => {
  resetCodexTtyChecks();
  t.after(resetCodexTtyChecks);
  const workspace = temp(), stateDir = temp(), invocation = temp();
  const launcher = (name, env = process.env) => ({ command: process.execPath, prefixArgs: [fakeCodex, path.join(stateDir, name)], env });
  const args = await installProtection({ cli: "codex", workspace, stateDir, invocation, launcher: launcher("current") });
  assert.deepEqual(args.slice(args.indexOf(CODEX_NO_TTY[1]) - 1, args.indexOf(CODEX_NO_TTY[1]) + 1), [...CODEX_NO_TTY]);
  assert.deepEqual(codexTtyCheck(launcher("current")), { ok: true, confirmed: true });
  // Its feature list still shows terminals on: refused, and checked again next time.
  const keepsOn = launcher("keeps-on", { ...process.env, FAKE_CODEX_TTY: "on" });
  await assert.rejects(installProtection({ cli: "codex", workspace, stateDir, invocation, launcher: keepsOn }), /without terminals/);
  assert.deepEqual(codexTtyCheck(keepsOn), { ok: false });
  // A CLI that can't list its features is refused: terminals can't be shown to be off (kadono 0.40.3 probe).
  const silent = path.join(stateDir, "silent.mjs"); writeFileSync(silent, "process.exit(2)");
  assert.deepEqual(codexTtyCheck({ command: process.execPath, prefixArgs: [silent] }), { ok: false, unreadable: true });
  await assert.rejects(installProtection({ cli: "codex", workspace, stateDir, invocation, launcher: { command: process.execPath, prefixArgs: [silent] } }), /could not be confirmed/);
  // A list without unified exec at all (an older Codex with no write_stdin) goes ahead, unconfirmed.
  const unlisted = path.join(stateDir, "unlisted.mjs"); writeFileSync(unlisted, "console.log('shell_tool  stable  true')");
  assert.deepEqual(codexTtyCheck({ command: process.execPath, prefixArgs: [unlisted] }), { ok: true, confirmed: false });
});

test("Claude's env scrub stays on only where Claude Code's own sandbox can start (kadono 0.40.1 probe)", () => {
  const dir = temp();
  const status = (name, report) => { const file = path.join(dir, `${name}.mjs`); writeFileSync(file, `console.log(${JSON.stringify(JSON.stringify(report))})`); return { command: process.execPath, prefixArgs: [file], env: { CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1" } }; };
  const missing = status("missing", { supported: true, enabled: true, unavailableReason: "socat is not installed" });
  assert.equal(claudeScrubProblem(missing, dir, "linux"), "socat is not installed");
  assert.equal(claudeRunEnvironment({ CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1", PATH: "p" }, missing, dir).CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, process.platform === "win32" ? "1" : "0");
  assert.equal(claudeScrubProblem(status("ready", { supported: true, enabled: true, unavailableReason: null }), dir, "linux"), null);
  assert.equal(claudeScrubProblem(status("unsupported", { supported: false, enabled: false }), dir, "darwin"), "not supported here");
  // No report (an older Claude Code): the scrub stays, and a failed start is caught in the run's output instead.
  const silent = path.join(dir, "silent.mjs"); writeFileSync(silent, "process.exit(1)");
  assert.equal(claudeScrubProblem({ command: process.execPath, prefixArgs: [silent] }, dir, "linux"), null);
  // Windows has no scrub sandbox to start.
  assert.equal(claudeScrubProblem(status("windows", { supported: false }), dir, "win32"), null);
});

test("a Claude run whose commands failed because Claude Code's sandbox couldn't start is refused, not reported as done", () => {
  const failed = { type: "user", message: { content: [{ type: "tool_result", is_error: true, content: "Sandbox is required but failed to initialize: socat not found. Restart to retry." }] } };
  const result = { type: "result", is_error: false, result: "All done." };
  const stdout = [failed, result].map((e) => JSON.stringify(e)).join("\n");
  assert.match(claudeSandboxFailure(stdout), /failed to initialize: socat not found/);
  assert.throws(() => extractClaudeResult(stdout), /sandbox failed to start.*socat not found/);
  // The same words in a successful command's output (a grep of this repository) are no failure.
  const quoted = { type: "user", message: { content: [{ type: "tool_result", is_error: false, content: [{ type: "text", text: "src: Sandbox is required but failed to initialize" }] }] } };
  assert.equal(claudeSandboxFailure([quoted, result].map((e) => JSON.stringify(e)).join("\n")), null);
  assert.equal(extractClaudeResult([quoted, result].map((e) => JSON.stringify(e)).join("\n")), "All done.");
});

test("where Claude Code's sandbox can't start, a run with an Anthropic key in its environment is refused instead of handing the key to its commands (release review 0.40.2)", { skip: process.platform === "win32" && "no scrub sandbox on Windows" }, async () => {
  const workspace = temp(), stateDir = temp(), invocation = temp();
  const fake = path.join(stateDir, "claude-nosocat.mjs");
  writeFileSync(fake, `console.log(${JSON.stringify(JSON.stringify({ supported: true, enabled: true, unavailableReason: "socat is not installed" }))})`);
  const launcher = (env) => ({ command: process.execPath, prefixArgs: [fake], env });
  await assert.rejects(installProtection({ cli: "claude", workspace, stateDir, invocation, launcher: launcher({ PATH: "p", ANTHROPIC_API_KEY: "sk-test", CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1" }) }), /would see your Anthropic key.*bubblewrap and socat/);
  // Signed in with /login: nothing for its commands to see, so the run goes without the scrub.
  const signedIn = launcher({ PATH: "p", CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1" });
  assert.equal((await installProtection({ cli: "claude", workspace, stateDir, invocation, launcher: signedIn }))[0], "--settings");
  assert.equal(claudeRunEnvironment(signedIn.env, signedIn, workspace).CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, "0");
});
