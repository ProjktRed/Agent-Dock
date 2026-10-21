import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ClaudeWorker, claudeChildEnv, extractClaudeResult, preflightClaude } from "../src/claude-worker.mjs";
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
      child.stdout.end(JSON.stringify(typeof envelope === "function" ? envelope(calls.length) : envelope));
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
  assert.deepEqual(args.slice(args.indexOf("--setting-sources"), args.indexOf("--setting-sources") + 2), ["--setting-sources", "user"], "only the user's own Claude settings");
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

test("a task without its Task skill line goes back to Assessment once with the reason", async () => {
  const calls = [];
  const w = await worker((n) => n === 1 ? ({ is_error: false, result: "", structured_output: { status: "task", task: { id: "t1", name: "n", prompt: "Goal: x", qaCommand: "npm test", allowedPaths: ["a.ts"] }, output: "", correction: "", commit: "", manualReviewCause: null } }) : ({ is_error: false, result: "", structured_output: { status: "task", task: { id: "t1", name: "n", prompt: "Task skill: implement\nGoal: x", qaCommand: "npm test", allowedPaths: ["a.ts"] }, output: "", correction: "", commit: "", manualReviewCause: null } }), calls);
  const result = await w.assess({ objective: "obj", previous: null });
  assert.equal(calls.length, 2);
  assert.match(calls[1].prompt, /must contain a line "Task skill: diagnose"/);
  assert.doesNotMatch(calls[0].prompt, /previous answer was rejected/);
  assert.match(result.task.prompt, /^Task skill: implement/);
});

test("a second answer without the Task skill line still blocks", async () => {
  const calls = [];
  const w = await worker(({ is_error: false, result: "", structured_output: { status: "task", task: { id: "t1", name: "n", prompt: "Goal: x", qaCommand: "npm test", allowedPaths: ["a.ts"] }, output: "", correction: "", commit: "", manualReviewCause: null } }), calls);
  await assert.rejects(w.assess({ objective: "obj", previous: null }), /Task skill selection is required/);
  assert.equal(calls.length, 2);
});

// npm installs Claude Code as claude.cmd: a fake one that records its arguments and stdin and answers like the CLI.
async function claudeShim(root, envelope) {
  await writeFile(path.join(root, "fake-claude.js"), `const fs = require("fs"), path = require("path");
const args = process.argv.slice(2);
if (args[0] === "auth") { process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: "shim" })); process.exit(0); }
let input = "";
process.stdin.on("data", (c) => (input += c)).on("end", () => {
  fs.writeFileSync(path.join(__dirname, "call.json"), JSON.stringify({ args, input }));
  process.stdout.write(${JSON.stringify(JSON.stringify(envelope))});
});
`);
  await writeFile(path.join(root, "claude.cmd"), `@ECHO off\r\nSETLOCAL\r\n"${process.execPath}" "%~dp0\\fake-claude.js" %*\r\n`);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PATH"));
  return { ...env, PATH: `${root};${process.env.PATH ?? ""}` };
}

test("an npm claude.cmd on PATH starts through cmd.exe for the worker and the preflight", { skip: process.platform !== "win32" }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude shim "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const task = { id: "t1", name: "n", prompt: "Task skill: implement\nGoal: x & \"y\" 100%", qaCommand: "npm test", allowedPaths: ["a.ts"] };
  const env = await claudeShim(root, { is_error: false, result: "", structured_output: { status: "task", task, output: "", correction: "", commit: "", manualReviewCause: null } });
  assert.deepEqual(await preflightClaude("claude", env), { command: "claude", auth: "shim" });
  const w = new ClaudeWorker({ stateDir: root, workspace: root, claudeCommand: "claude", env, writeProcessState: async () => {}, clearProcessState: async () => {} });
  assert.match(w.prefixArgs.join(" "), /^\/d \/s \/c .*claude\.cmd$/i);
  const result = await w.assess({ objective: "obj & more", previous: null });
  assert.equal(result.task.prompt, task.prompt);
  const { args, input } = JSON.parse(await readFile(path.join(root, "call.json"), "utf8"));
  assert.deepEqual(args.slice(args.indexOf("--setting-sources"), args.indexOf("--setting-sources") + 2), ["--setting-sources", "user"]);
  assert.ok(JSON.parse(args[args.indexOf("--json-schema") + 1]).properties, "the JSON schema arrives intact");
  assert.ok(JSON.parse(args[args.indexOf("--settings") + 1]).hooks.PreToolUse.length, "the hook settings arrive intact");
  assert.ok(args.includes("--disallowedTools") && args.includes("dontAsk"));
  assert.match(input, /^You are Assessment, performing[\s\S]*obj & more/, "the prompt goes through stdin");
});
