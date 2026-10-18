import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ClaudeWorker, claudeChildEnv, extractClaudeResult } from "../src/claude-worker.mjs";
import { CodexUsageLimitError } from "../src/codex-worker.mjs";

function fakeSpawn(envelope, calls) {
  return (command, args, options) => {
    const child = new EventEmitter();
    child.pid = 4242;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    let prompt = "";
    child.stdin.on("data", (c) => (prompt += c));
    child.stdin.on("finish", () => {
      calls.push({ command, args, options, prompt });
      child.stdout.end(JSON.stringify(envelope));
      child.stderr.end();
      setImmediate(() => child.emit("close", 0));
    });
    return child;
  };
}

async function worker(envelope, calls) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "claude-worker-"));
  return new ClaudeWorker({
    stateDir, workspace: stateDir, claudeCommand: "claude",
    env: { PATH: "x", CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "s", ANTHROPIC_API_KEY: "k" },
    spawnProcess: fakeSpawn(envelope, calls),
    writeProcessState: async () => {}, clearProcessState: async () => {},
  });
}

const recovery = { status: "strategy-revised", preserve: [], rootProblem: "r", previousStrategyFailure: "p", newStrategy: "n", nextWorkerInstructions: "do x", neededEvidence: [], failureReason: "f" };

test("assessment runs Sonnet read-only with structured output and a clean env", async () => {
  const calls = [];
  const task = { id: "t1", name: "n", prompt: "Task skill: implement\nGoal: x", qaCommand: "npm test", allowedPaths: ["a.ts"] };
  const w = await worker({ is_error: false, result: "", structured_output: { status: "task", task, output: "", correction: "", commit: "", manualReviewCause: null } }, calls);
  const result = await w.assess({ objective: "obj", previous: null });
  assert.equal(result.status, "task");
  const { args, options, prompt } = calls[0];
  assert.deepEqual(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2), ["--model", "sonnet"]);
  assert.ok(args.includes("--json-schema") && args.includes("dontAsk"));
  assert.ok(args.includes('--settings'), 'orchestrators must load the protected-path hook');
  assert.ok(JSON.parse(args[args.indexOf('--settings')+1]).hooks.PreToolUse.length);
  assert.ok(!args.includes("Bash") && !args.includes("PowerShell"), "no unrestricted shell");
  assert.ok(!args.some((a) => /git (add|commit)/.test(a)), "assessment cannot commit");
  assert.ok(args.includes("Edit") && args.indexOf("Edit") > args.indexOf("--disallowedTools"));
  assert.equal(options.env.CLAUDECODE, undefined);
  assert.equal(options.env.CLAUDE_CODE_SESSION_ID, undefined);
  assert.equal(options.env.ANTHROPIC_API_KEY, "k");
  assert.match(prompt, /^You are Assessment, performing/);
  assert.doesNotMatch(prompt, /GPT-6|Sol\b|Astra|Sonnet|Opus/, "role prompts name no model");
});

test("QA may run scoped checks and commit, but never gets a free shell", async () => {
  const calls = [];
  const w = await worker({ is_error: false, structured_output: { status: "pass", task: null, output: "ok", correction: "", commit: "abc", manualReviewCause: null, verifiedIssue: null } }, calls);
  const result = await w.review({ task: { id: "t" } });
  assert.equal(result.commit, "abc");
  const { args, prompt } = calls[0];
  assert.ok(args.includes("Bash(git commit:*)") && args.includes("Bash(npm test:*)"));
  assert.ok(!args.includes("Bash") && !args.includes("PowerShell"));
  assert.match(prompt, /^You are QA, performing/);
});

test("elevation uses Opus", async () => {
  const calls = [];
  const w = await worker({ is_error: false, structured_output: recovery }, calls);
  await w.reassessManualReview({});
  const { args, prompt } = calls[0];
  assert.equal(args[args.indexOf("--model") + 1], "opus");
  assert.match(prompt, /^You are Elevation\./);
});

test("usage limits become the loop's resumable usage-limit error", () => {
  assert.throws(() => extractClaudeResult(JSON.stringify({ is_error: true, result: "Claude usage limit reached · resets 3pm" })), CodexUsageLimitError);
  assert.throws(() => extractClaudeResult(JSON.stringify({ is_error: true, result: "Not logged in · Please run /login" })), /Not logged in/);
  assert.equal(extractClaudeResult(JSON.stringify({ is_error: false, result: "```json\n{\"a\":1}\n```" })), '{"a":1}');
});

test("helpers strip only Claude session variables", () => {
  assert.deepEqual(claudeChildEnv({ CLAUDECODE: "1", CLAUDE_PID: "2", CLAUDEX: "keep", PATH: "p" }), { CLAUDEX: "keep", PATH: "p" });
});
