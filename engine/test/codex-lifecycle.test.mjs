import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { correction } from "../fixtures/recovery-harness.mjs";
import { CodexWorker, recoveryOutputSchema, parseRecoveryResult } from "../src/codex-worker.mjs";
import { runNodeLoop, verifyReview } from "../src/node-loop.mjs";
import { atomicWriteJson } from "../src/dashboard-state.mjs";

const fixture = fileURLToPath(new URL("../fixtures/fake-codex-process.mjs", import.meta.url));
const task = { id: "test", name: "Test", prompt: "Create result", qaCommand: "node --version", allowedPaths: ["result.txt"] };
const strictResult = (overrides = {}) => ({ status: "done", task: null, output: "", correction: "", commit: "", manualReviewCause: null, ...overrides });

test("QA invocation does not combine mutually exclusive approval and sandbox flags", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-args-"));
  try {
    const codex = new CodexWorker({ workspace: root, stateDir: root, command: process.execPath, prefixArgs: [fixture, path.join(root, "pids.json")] });
    assert.equal((await codex.invoke(JSON.stringify(strictResult({ status: "fail" })), "workspace-write")).status, "fail");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("explicit Windows sandbox mode is passed without disabling workspace boundaries", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-windows-mode-"));
  const argsFile = path.join(root, "args.json");
  const previous = process.env.FAKE_CODEX_ARGS_FILE;
  process.env.FAKE_CODEX_ARGS_FILE = argsFile;
  try {
    const codex = new CodexWorker({ workspace: root, stateDir: root, command: process.execPath, prefixArgs: [fixture, path.join(root, "pids.json")], windowsSandbox: "unelevated" });
    await codex.invoke(JSON.stringify(strictResult({ status: "fail" })), "workspace-write");
    const args = JSON.parse(await readFile(argsFile, "utf8"));
    assert.ok(args.includes('windows.sandbox="unelevated"'));
    assert.ok(args.includes("--approve-for-me"));
    assert.equal(args.includes("--dangerously-bypass-approvals-and-sandbox"), false);
    assert.throws(() => new CodexWorker({ workspace: root, stateDir: root, windowsSandbox: "disabled" }), /Invalid Windows sandbox/);
  } finally {
    if (previous === undefined) delete process.env.FAKE_CODEX_ARGS_FILE;
    else process.env.FAKE_CODEX_ARGS_FILE = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("a Codex QA or Assessment run that used tools without a single protection hook decision is refused", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-fail-closed-"));
  const previous = process.env.FAKE_CODEX_TOOL;
  try {
    const codex = new CodexWorker({ workspace: root, stateDir: root, command: process.execPath, prefixArgs: [fixture, path.join(root, "pids.json")] });
    const result = JSON.stringify(strictResult({ status: "fail" }));
    process.env.FAKE_CODEX_TOOL = "unhooked";
    await assert.rejects(codex.invoke(result, "workspace-write"), /without the scope hook/);
    await assert.rejects(codex.invoke(result, "read-only"), /without the scope hook/);
    process.env.FAKE_CODEX_TOOL = "hooked";
    assert.equal((await codex.invoke(result, "workspace-write")).status, "fail");
  } finally {
    if (previous === undefined) delete process.env.FAKE_CODEX_TOOL;
    else process.env.FAKE_CODEX_TOOL = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("one-shot Sol invocation passes the requested model and medium reasoning config", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-sol-args-"));
  const argsFile = path.join(root, "args.json");
  const previous = process.env.FAKE_CODEX_ARGS_FILE;
  process.env.FAKE_CODEX_ARGS_FILE = argsFile;
  try {
    const codex = new CodexWorker({ workspace: root, stateDir: root, command: process.execPath, prefixArgs: [fixture, path.join(root, "pids.json")] });
    await codex.invoke(JSON.stringify(strictResult({ status: "manual-review" })), "read-only", { model: "gpt-5.6-sol", reasoningEffort: "medium" });
    const args = JSON.parse(await readFile(argsFile, "utf8"));
    assert.deepEqual(args.slice(args.indexOf("-m"), args.indexOf("-m") + 2), ["-m", "gpt-5.6-sol"]);
    assert.deepEqual(args.slice(args.indexOf("-c"), args.indexOf("-c") + 2), ["-c", 'model_reasoning_effort="medium"']);
  } finally {
    if (previous === undefined) delete process.env.FAKE_CODEX_ARGS_FILE;
    else process.env.FAKE_CODEX_ARGS_FILE = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace-write QA adds the linked-worktree Git directory without widening assessment", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-add-dir-"));
  const argsFile = path.join(root, "args.json");
  const previous = process.env.FAKE_CODEX_ARGS_FILE;
  process.env.FAKE_CODEX_ARGS_FILE = argsFile;
  try {
    const gitCommonDir = path.join(root, "external-git");
    const codex = new CodexWorker({
      workspace: root,
      stateDir: root,
      command: process.execPath,
      prefixArgs: [fixture, path.join(root, "pids.json")],
      additionalWritableDirs: [gitCommonDir],
    });

    await codex.invoke(JSON.stringify(strictResult({ status: "fail" })), "workspace-write");
    const qaArgs = JSON.parse(await readFile(argsFile, "utf8"));
    assert.deepEqual(qaArgs.slice(qaArgs.indexOf("--add-dir"), qaArgs.indexOf("--add-dir") + 2), ["--add-dir", gitCommonDir]);

    await codex.invoke(JSON.stringify(strictResult()), "read-only");
    const assessmentArgs = JSON.parse(await readFile(argsFile, "utf8"));
    assert.equal(assessmentArgs.includes("--add-dir"), false);
  } finally {
    if (previous === undefined) delete process.env.FAKE_CODEX_ARGS_FILE;
    else process.env.FAKE_CODEX_ARGS_FILE = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("real child processes: assessment/FAIL/PASS exit fully before every fake Cline run", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-lifecycle-"));
  try {
    const pids = path.join(root, "pids.json");
    const codex = new CodexWorker({ workspace: root, stateDir: root, command: process.execPath, prefixArgs: [fixture, pids] });
    let assessments = 0;
    let reviews = 0;
    let clineRuns = 0;
    const events = [];
    const prompts = [];
    const result = await runNodeLoop({
      workspace: root, stateDir: root, maxAttempts: 2,
      assess: async () => codex.invoke(JSON.stringify(++assessments === 1 ? strictResult({ status: "task", task }) : strictResult())),
      review: async () => codex.invoke(JSON.stringify(++reviews === 1
        ? strictResult({ status: "fail", output: "expected READY, got BROKEN", correction: "Fix result to READY" })
        : strictResult({ status: "pass", output: "Tests passed", commit: "verified" }))),
      assessCorrection:async()=>codex.invoke(JSON.stringify({...correction(),nextWorkerInstructions:"Fix result to READY"}),"read-only",{schema:recoveryOutputSchema,parse:parseRecoveryResult}),
      codex,
      worker: {
        withExclusive: async (fn) => fn(),
        run: async (prompt) => {
          clineRuns++;
          prompts.push(prompt);
          assert.equal(codex.activeCount, 0);
          // A separate fake Cline process checks, repeatedly during its run, that no fake Codex process
          // is still alive: each one keeps a marker file for exactly its life (PIDs are reused on Windows).
          const code = `const fs=require('fs'),path=require('path'); const base=process.argv[1],dir=path.dirname(base),prefix=path.basename(base)+'.alive-'; let n=0; const timer=setInterval(()=>{ if(fs.readdirSync(dir).some(f=>f.startsWith(prefix)))process.exit(9); if(++n===8){clearInterval(timer);process.exit(0)}},20);`;
          const exit = await new Promise((resolve, reject) => {
            const child = spawn(process.execPath, ["-e", code, pids], { windowsHide: true });
            child.on("error", reject);
            child.on("close", resolve);
          });
          assert.equal(exit, 0, "No Codex PID may be alive while Cline runs");
          return { exitCode: 0, output: "done" };
        },
      },
      baseline: async () => ({ head: "baseline" }),
      verify: async () => {},
      readControl: async () => ({}),
      onEvent: async (event) => events.push(event.type),
    });
    assert.equal(result.status, "done", JSON.stringify(result).slice(0, 600));
    assert.equal(clineRuns, 2);
    assert.equal(assessments, 2);
    assert.equal(reviews, 2);
    assert.match(prompts[1], /Fix result to READY/);
    assert.equal(JSON.parse(await readFile(pids)).length, 5);
    assert.ok(events.indexOf("codex-finished") < events.indexOf("cline-started"));
    assert.ok(events.includes("codex-qa-finished"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a surviving Codex PID from an interrupted manager blocks a new launch", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-orphan-"));
  try {
    const codex = new CodexWorker({ workspace: root, stateDir: root });
    await atomicWriteJson(path.join(root, "codex-process.json"), { pid: process.pid });
    await assert.rejects(codex.assertIdle(), /still alive/);
    await assert.rejects(codex.invoke("must not launch"), /still alive/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("actionable QA failures continue past former limit through Assessment", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-retries-"));
  try {
    let runs = 0;
    let assessments = 0;
    const events = [];
    const reviewAttempts = [];
    const result = await runNodeLoop({
      workspace: root, stateDir: root, codex: { activeCount: 0 },
      assess: async () => ++assessments === 1 ? { status: "task", task } : { status: "done" },
      assessCorrection:async()=>correction(), solReassessmentEnabled:false,
      review: async (packet) => {
        reviewAttempts.push(packet.attempt);
        return packet.attempt < 6
          ? { status: "fail", output: `Attempt ${packet.attempt} still fails`, correction: `Revise result.txt using strategy ${packet.attempt}` }
          : { status: "pass", output: "QA passed", commit: "fake" };
      },
      worker: { withExclusive: async (fn) => fn(), run: async () => { runs++; return { exitCode: 0 }; } },
      baseline: async () => ({ head: "base" }), verify: async () => {},
      prepareQa: async ({ task, attempt, workerResult }) => ({ task, attempt, workerResult, changedFiles: [], diff: { bytes: 0 }, qaEvidence: { command: { command: task.qaCommand }, categories: {} } }),
      readControl: async () => ({}), onEvent: async (event) => events.push(event),
    });
    assert.equal(result.status, "done");
    assert.equal(runs, 6);
    assert.equal(assessments, 2);
    assert.deepEqual(reviewAttempts, [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(events.filter((event) => event.type === "strategy-reassessment").map((event) => event.attempt), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("pause after PASS waits in Node; resume allows the next assessment", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-pause-"));
  try {
    let paused = false;
    let sawPause = false;
    let assessments = 0;
    const result = await runNodeLoop({
      workspace: root, stateDir: root, codex: { activeCount: 0 },
      assess: async () => { assessments++; return assessments === 1 ? { status: "task", task } : { status: "done" }; },
      review: async () => { paused = true; return { status: "pass", output: "QA passed", commit: "fake" }; },
      worker: { withExclusive: async (fn) => fn(), run: async () => ({ exitCode: 0 }) },
      baseline: async () => ({ head: "base" }), verify: async () => {},
      readControl: async () => ({ pauseAfterCurrent: paused }),
      onEvent: async (event) => {
        if (event.type === "paused") { assert.equal(assessments, 1); sawPause = true; paused = false; }
      },
    });
    assert.equal(result.status, "done");
    assert.equal(sawPause, true);
    assert.equal(assessments, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("stop at a safe boundary starts neither assessment nor Cline", async () => {
  const result = await runNodeLoop({
    codex: { activeCount: 0 },
    worker: { withExclusive: async () => { throw new Error("must not launch"); } },
    readControl: async () => ({ stopAfterSafePoint: true }),
    onEvent: async () => {},
  });
  assert.equal(result.status, "stopped");
});

test("PASS verification requires a real bounded commit; failed QA cannot change HEAD", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-commit-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const commit = () => git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture");
  try {
    git("init");
    await writeFile(path.join(root, "result.txt"), "before");
    git("add", "result.txt"); commit();
    const baselineHead = git("rev-parse", "HEAD");
    await assert.rejects(verifyReview({ workspace: root, baselineHead, task, decision: { status: "pass", output: "pass", commit: baselineHead } }), /matching new commit/);
    await writeFile(path.join(root, "result.txt"), "after");
    git("add", "result.txt"); commit();
    const head = git("rev-parse", "HEAD");
    await verifyReview({ workspace: root, baselineHead, task, decision: { status: "pass", output: "tests passed", commit: head } });
    await assert.rejects(verifyReview({ workspace: root, baselineHead, task, decision: { status: "fail" } }), /changed HEAD/);
    await assert.rejects(verifyReview({ workspace: root, baselineHead, task: { ...task, allowedPaths: ["other.txt"] }, decision: { status: "pass", output: "pass", commit: head } }), /outside the bounded task/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

// Rev F12: an orchestration call that never ends hung the run; a check that never exits did too.
test("a Codex call and a check that never finish are ended with their process tree", async () => {
  const { runShellCommand } = await import("../src/qa-packet.mjs");
  const { appendBounded } = await import("../src/process-bounds.mjs");
  const { existsSync } = await import("node:fs");
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-deadline-"));
  try {
    const codex = new CodexWorker({ workspace: root, stateDir: root, command: process.execPath, prefixArgs: [fixture, path.join(root, "pids.json")], env: { ...process.env, FAKE_CODEX_HANG: "1" }, callTimeoutMs: 1500 });
    await assert.rejects(codex.invoke(JSON.stringify(strictResult()), "read-only"), /did not finish within <1 minutes and was ended/);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    for (const pid of JSON.parse(await readFile(path.join(root, "pids.json"), "utf8"))) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "the fake Codex process is gone");
    await writeFile(path.join(root, "hang.js"), "setInterval(() => console.log(1), 10);\n");
    const check = await runShellCommand("node hang.js", root, { timeoutMs: 1000 });
    assert.equal(check.exitCode, 1);
    assert.equal(check.timedOut, true);
    assert.equal(existsSync(root), true);
    const long = appendBounded("a".repeat(90), "b".repeat(20), 100);
    assert.equal(long.length, 100);
    assert.match(long, /^\[earlier output cut\]\n/);
    assert.ok(long.endsWith("b".repeat(20)));
  } finally { await rm(root, { recursive: true, force: true }); }
});
