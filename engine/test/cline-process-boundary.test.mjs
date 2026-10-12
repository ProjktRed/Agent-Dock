import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";

import { ClineCliWorker } from "../src/cline-cli-worker.mjs";
import * as clineAdapter from "../src/cline-cli-worker.mjs";
import { DashboardState } from "../src/dashboard-state.mjs";
import { startDashboardServer } from "../src/dashboard-server.mjs";
import { runNodeLoop } from "../src/node-loop.mjs";

const fakeCline = fileURLToPath(new URL("../fixtures/fake-cline-process.mjs", import.meta.url));
const task = { id: "boundary", name: "Boundary test", prompt: "hold-pipes", qaCommand: "fake", allowedPaths: ["proof.txt"] };
const timeout = (ms) => new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), ms));

async function harness({ prompt, exitDecision = "pass", maxAttempts = 1, launch }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "cline-boundary-"));
  const workspace = path.join(root, "workspace");
  const stateDir = path.join(root, ".state");
  await mkdir(workspace);
  execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
  const state = new DashboardState({ stateDir });
  const activeTask = { ...task, prompt };
  await state.initialize({ task: activeTask, workspace, maxAttempts });
  const dashboard = await startDashboardServer({ stateDir, workspace, port: 0 });
  const worker = new ClineCliWorker({
    stateDir,
    workspace,
    clineJs: fakeCline,
    checkExternalBusy: async () => false,
    timeoutSeconds: 10,
    ...(launch ? { launch } : {}),
  });
  let qaLaunches = 0;
  const codex = {
    activeCount: 0,
    assertIdle: async () => {},
    assess: async () => ({ status: "done" }),
    review: async () => {
      qaLaunches += 1;
      if (exitDecision === "pass") return { status: "pass", output: "fake QA pass", commit: "fake" };
      if (exitDecision === "manual-review") return { status: "manual-review", output: "fake QA failure", manualReviewCause:"missing-permissions", correction: "" };
      return { status: "fail", output: "fake QA failure", correction: "fix it" };
    },
  };
  const events = [];
  const loop = runNodeLoop({
    workspace,
    stateDir,
    objective: "fake",
    initialTask: activeTask,
    codex,
    worker,
    maxAttempts,
    baseline: async () => ({ head: "fake" }),
    prepareQa: async ({ task: packetTask, attempt, baselineSha, workerResult }) => ({
      task: { id: packetTask.id, name: packetTask.name, objective: packetTask.prompt, allowedPaths: packetTask.allowedPaths },
      acceptanceCriteria: [], baselineSha, diff: { text: "", bytes: 0, truncated: false }, changedFiles: [],
      clineSummary: { exitCode: workerResult.exitCode, finishReason: workerResult.runResult?.finishReason ?? null, text: "fake" },
      attempt,
      qaEvidence: { command: { command: packetTask.qaCommand, exitCode: 0, durationMs: 0, summary: "fake", truncated: false }, categories: { tests: "NOT RUN", typecheck: "NOT RUN", lint: "NOT RUN", build: "NOT RUN", scopeCheck: "PASS" }, durationMs: 0 },
    }),
    verify: async () => {},
    readControl: () => state.readControl(),
    onTask: async () => {},
    onEvent: async (event) => {
      events.push(event);
      await state.record(event);
    },
    pollMs: 10,
  }).catch(async (error) => {
    await state.record({ type: "manual-review", qa: error.message });
    return { status: "manual-review", output: error.message };
  });
  return { root, stateDir, state, dashboard, loop, events, getQaLaunches: () => qaLaunches };
}

async function dispose(run) {
  await run.loop.catch(() => {});
  await run.dashboard.close();
  await rm(run.root, { recursive: true, force: true });
}

test("Cline exit is authoritative when an inherited stdout pipe remains open", async () => {
  let heldStdout;
  let heldStderr;
  const spawnProcess = () => {
    const child = new EventEmitter();
    child.stdout = heldStdout = new PassThrough();
    child.stderr = heldStderr = new PassThrough();
    child.stdin = new PassThrough();
    queueMicrotask(() => {
      child.stdout.write(`${JSON.stringify({ type: "run_result", finishReason: "completed" })}\n`);
      child.emit("exit", 0, null);
      // A descendant deliberately keeps both output handles open and prevents close.
    });
    return child;
  };
  const run = await harness({
    prompt: "hold-pipes",
    launch: () => clineAdapter.collectClineProcess("fake", [], { spawnProcess, drainTimeoutMs: 50 }),
  });
  try {
    const before = await fetch(`${run.dashboard.url}/api/status`);
    assert.equal(before.status, 200);
    const quick = await Promise.race([run.loop, timeout(400)]);
    assert.notEqual(quick.timedOut, true, "worker waited for descendant-held pipe close");
    assert.equal(run.getQaLaunches(), 1);
    assert.ok(run.events.some((event) => event.type === "codex-qa-started"));
    assert.equal(heldStdout.destroyed, true);
    assert.equal(heldStderr.destroyed, true);
    assert.equal((await fetch(`${run.dashboard.url}/api/status`)).status, 200);
    assert.equal(await run.state.readLive().then((live) => live.stage), "complete");
    await assert.rejects(import("node:fs/promises").then(({ access }) => access(path.join(run.stateDir, "cline.busy.lock"))));
  } finally {
    await dispose(run);
  }
});

test("non-zero Cline exit can enter explicit controlled manual review while dashboard stays alive", async () => {
  const run = await harness({ prompt: "nonzero", exitDecision: "manual-review" });
  try {
    const result = await run.loop;
    assert.equal(result.status, "blocked");
    assert.ok(run.events.some((event) => event.type === "cline-finished" && event.exitCode === 7));
    const status = await fetch(`${run.dashboard.url}/api/status`).then((response) => response.json());
    assert.equal(status.stage, "BLOCKED");
    assert.match(status.latestQa, /fake QA failure/);
  } finally {
    await dispose(run);
  }
});

test("bounded Cline timeout remains a controlled manual-review state", async () => {
  const run = await harness({ prompt: "timeout", exitDecision: "manual-review" });
  try {
    const result = await run.loop;
    assert.equal(result.status, "blocked");
    assert.ok(run.events.some((event) => event.type === "cline-finished" && event.exitCode === 124));
    assert.equal((await fetch(`${run.dashboard.url}/api/status`)).status, 200);
  } finally { await dispose(run); }
});

test("stdout and stderr ending before process exit cannot deadlock completion", async () => {
  for (const prompt of ["stdout-first", "stderr-first"]) {
    const run = await harness({ prompt });
    try {
      const result = await Promise.race([run.loop, timeout(400)]);
      assert.notEqual(result.timedOut, true, `${prompt} deadlocked`);
      assert.equal(run.getQaLaunches(), 1);
    } finally {
      await dispose(run);
    }
  }

  const spawnProcess = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    queueMicrotask(() => {
      child.stdout.write(`${JSON.stringify({ type: "run_result", finishReason: "completed" })}\n`);
      child.emit("exit", 0, null);
      setTimeout(() => {
        child.stdout.end();
        child.stderr.end();
        child.emit("close", 0, null);
      }, 20);
    });
    return child;
  };
  const afterExit = await Promise.race([
    clineAdapter.collectClineProcess("fake", [], { spawnProcess, drainTimeoutMs: 100 }),
    timeout(300),
  ]);
  assert.notEqual(afterExit.timedOut, true, "streams ending after exit deadlocked");
  assert.equal(afterExit.exitCode, 0);
});

test("missing or malformed final run_result becomes manual review without stopping dashboard", async () => {
  for (const prompt of ["malformed", "incomplete"]) {
    const run = await harness({ prompt });
    try {
      const result = await run.loop;
      assert.equal(result.status, "blocked");
      assert.match(result.output, /run_result/i);
      const response = await fetch(`${run.dashboard.url}/api/status`);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).stage, "BLOCKED");
    } finally {
      await dispose(run);
    }
  }
});

test("worker completion cannot terminate or close the dashboard process", async () => {
  const run = await harness({ prompt: "success" });
  try {
    await run.loop;
    assert.equal(process.exitCode, undefined);
    const first = await fetch(`${run.dashboard.url}/api/status`);
    const second = await fetch(`${run.dashboard.url}/api/status`);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
  } finally {
    await dispose(run);
  }
});
