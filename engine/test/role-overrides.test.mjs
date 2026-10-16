import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseLoopOptions, parseRoleOverrides } from "../src/loop-options.mjs";
import { CodexWorker, ROLE_EFFORT, ROLE_FAST, roleOptions, useOrchestratorModels, useRoleOverrides } from "../src/codex-worker.mjs";
import { CLAUDE_MODELS, ClaudeWorker } from "../src/claude-worker.mjs";

const CODEX_DEFAULTS = { qa: "gpt-6.1-sol", assessment: "gpt-6.1-sol", resolver: "gpt-6.1-sol", elevate: "gpt-6-astra", reasoning: "medium" };
const reset = () => {
  useOrchestratorModels(CODEX_DEFAULTS);
  for (const role of Object.keys(ROLE_FAST)) ROLE_FAST[role] = false;
};

function captureSpawn(calls, stdout = "") {
  return (command, args, options) => {
    const child = new EventEmitter();
    child.pid = 4242;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    child.stdin.on("finish", () => {
      calls.push({ command, args, options });
      child.stdout.end(stdout);
      child.stderr.end();
      setImmediate(() => child.emit("close", 0));
    });
    return child;
  };
}

const fakeState = { writeProcessState: async () => {}, clearProcessState: async () => {} };

test("role flags parse into overrides; roles without flags are absent", () => {
  const options = parseLoopOptions(["--workspace", "w", "--objective", "o", "--qa-model", "gpt-6-luna", "--qa-effort", "high", "--elevate-fast", "true"]);
  assert.deepEqual(options.roleOverrides, { qa: { model: "gpt-6-luna", effort: "high" }, elevate: { fast: true } });
  assert.deepEqual(parseRoleOverrides({}), {});
});

test("invalid efforts and model identifiers are rejected", () => {
  assert.throws(() => parseRoleOverrides({ "qa-effort": "turbo" }), /qa-effort must be one of/);
  assert.throws(() => parseRoleOverrides({ "qa-model": "bad model; rm" }), /not a valid model identifier/);
  assert.throws(() => parseRoleOverrides({ "qa-fast": "yes" }), /qa-fast must be true or false/);
  assert.doesNotThrow(() => parseRoleOverrides({ "qa-model": "claude-opus-4-8[1m]" }));
});

test("defaults are unchanged without overrides; fast only appears when enabled", () => {
  reset();
  assert.deepEqual(roleOptions("qa"), { model: "gpt-6.1-sol", reasoningEffort: "medium" });
  useRoleOverrides({ assessment: { model: "gpt-6-sol", effort: "xhigh", fast: true } });
  assert.deepEqual(roleOptions("assessment"), { model: "gpt-6-sol", reasoningEffort: "xhigh", fast: true });
  assert.deepEqual(roleOptions("qa"), { model: "gpt-6.1-sol", reasoningEffort: "medium" });
  assert.equal(ROLE_EFFORT.elevate, "medium");
  reset();
});

test("Codex gets -m, the effort and the priority service tier for a Fast role", async () => {
  const calls = [];
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "role-codex-"));
  const codex = new CodexWorker({ workspace: stateDir, stateDir, spawnProcess: captureSpawn(calls), ...fakeState });
  await codex.invoke("p", "read-only", { model: "gpt-6-luna", reasoningEffort: "low", fast: true }).catch(() => {});
  const args = calls[0].args;
  assert.equal(args[args.indexOf("-m") + 1], "gpt-6-luna");
  assert.ok(args.includes('model_reasoning_effort="low"'));
  assert.ok(args.includes('service_tier="priority"'));
  calls.length = 0;
  await codex.invoke("p", "read-only", { model: "gpt-6-luna", reasoningEffort: "low" }).catch(() => {});
  assert.ok(!calls[0].args.some((a) => a.startsWith("service_tier")), "standard speed keeps the user's config");
});

test("Claude uses an overridden model and effort as given, and opts in to fast mode", async () => {
  const calls = [];
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "role-claude-"));
  const envelope = JSON.stringify({ is_error: false, structured_output: { status: "manual-review", task: null, output: "", correction: "", commit: "", manualReviewCause: "x" } });
  const claude = new ClaudeWorker({ stateDir, workspace: stateDir, env: { PATH: "x" }, spawnProcess: captureSpawn(calls, envelope), ...fakeState });
  await claude.invoke("p", "read-only", { model: "claude-opus-4-8", reasoningEffort: "max", fast: true });
  const args = calls[0].args;
  assert.equal(args[args.indexOf("--model") + 1], "claude-opus-4-8");
  assert.equal(args[args.indexOf("--effort") + 1], "max");
  assert.equal(JSON.parse(args[args.indexOf("--settings") + 1]).fastMode, true);
  calls.length = 0;
  await claude.invoke("p", "read-only", { model: "gpt-6-astra", reasoningEffort: "medium" });
  assert.equal(calls[0].args[calls[0].args.indexOf("--model") + 1], CLAUDE_MODELS.elevate, "Codex default labels still map to the Claude defaults");
  assert.equal(JSON.parse(calls[0].args[calls[0].args.indexOf('--settings')+1]).fastMode,false);
});
