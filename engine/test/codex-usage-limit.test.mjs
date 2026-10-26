import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {startTestLoop} from '../fixtures/test-loop.mjs';
import { fileURLToPath } from "node:url";

import {
  CodexUsageLimitError,
  detectCodexUsageLimit,
} from "../src/codex-worker.mjs";
import {
  readPendingCodex,
  recoverLegacyQaLimit,
  runNodeLoop,
} from "../src/node-loop.mjs";
import { DashboardState, atomicWriteJson } from "../src/dashboard-state.mjs";

const task = {
  id: "limit-task",
  name: "Limit task",
  prompt: "Implement without changing scope",
  qaCommand: "node --version",
  allowedPaths: ["result.txt"],
};

const limitMessage = "You've hit your usage limit. Purchase more credits or try again at 10:07 PM.";
const limitError = () => new CodexUsageLimitError({ message: limitMessage, retryAt: "try again at 10:07 PM" });
const genericFailureFixture = fileURLToPath(new URL("../fixtures/fake-codex-error.mjs", import.meta.url));
// Usage-limit tests exercise orchestration, not Git/subprocess QA collection.
const prepareQa = async ({task,attempt,baselineSha,workerResult}) => ({task,attempt,baselineSha,
  changedFiles:['result.txt'],diff:{text:'existing implementation',bytes:23},
  clineSummary:{exitCode:workerResult.exitCode,text:workerResult.output},
  qaEvidence:{command:{command:task.qaCommand,exitCode:0},categories:{tests:'PASS',scopeCheck:'PASS'},scope:{status:'PASS'}},
});

test("structured Codex failures detect limits and preserve exact reset text", () => {
  const output = [
    JSON.stringify({ type: "item.completed", item: { output: "usage limit in unrelated command output" } }),
    JSON.stringify({ type: "error", message: limitMessage }),
    JSON.stringify({ type: "turn.failed", error: { message: limitMessage } }),
  ].join("\n");
  assert.deepEqual(detectCodexUsageLimit(output), {
    message: limitMessage,
    retryAt: "try again at 10:07 PM",
  });
  assert.equal(detectCodexUsageLimit(JSON.stringify({ type: "turn.failed", error: { message: "authentication failed" } })), null);
  assert.match(detectCodexUsageLimit(JSON.stringify({ type: "turn.failed", error: { code: "credits_exhausted", message: "No credits remaining" } })).message, /credits/i);
});

test("ordinary Codex exit code 1 remains a genuine error", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-generic-error-"));
  try {
    const { CodexWorker } = await import("../src/codex-worker.mjs");
    const codex = new CodexWorker({ workspace: root, stateDir: root, command: process.execPath, prefixArgs: [genericFailureFixture] });
    await assert.rejects(codex.invoke("ignored"), (error) => {
      assert.equal(error.code, undefined);
      assert.match(error.message, /Codex exited with code 1/);
      assert.match(error.message, /ordinary fake failure/);
      return true;
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("QA usage limit waits, preserves task/diff/attempt, and Resume reruns only the same QA", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-limit-qa-"));
  const stateDir = path.join(root, ".state");
  const state = new DashboardState({ stateDir });
  await writeFile(path.join(root, "result.txt"), "existing implementation\n");
  await state.initialize({ task, workspace: root, maxAttempts: 2 });
  let reviews = 0;
  let clineRuns = 0;
  let assessments = 0;
  let firstReviewInput;
  const loop = startTestLoop({
    prepareQa,
    workspace: root, stateDir, objective: "bounded", initialTask: task, maxAttempts: 2,
    codex: { activeCount: 0 },
    worker: { withExclusive: async (fn) => fn(), run: async () => { clineRuns++; return { exitCode: 0, output: "same worker result" }; } },
    baseline: async () => ({ head: "base" }), verify: async () => {}, pollMs: 10,
    readControl: () => state.readControl(), onEvent: (event) => state.record(event),
    onTask: async () => {},
    assess: async () => { assessments++; return { status: "done" }; },
    review: async (input) => {
      reviews++;
      firstReviewInput ??= structuredClone(input);
      if (reviews === 1) throw limitError();
      assert.deepEqual(input, firstReviewInput);
      return { status: "pass", output: "fake pass", commit: "fake" };
    },
  });
  try {
    await loop.waitForEvent('waiting-for-codex');
    const waiting = await state.readLive();
    assert.equal(waiting.qaStatus, "waiting-for-codex");
    assert.equal(waiting.attempt, 1);
    assert.equal(waiting.task.id, task.id);
    assert.equal(waiting.interruptedOperation, "qa");
    assert.equal(waiting.codexRetryAt, "try again at 10:07 PM");
    assert.equal(await readFile(path.join(root, "result.txt"), "utf8"), "existing implementation\n");
    assert.equal(clineRuns, 1);
    const pending = await readPendingCodex(stateDir);
    assert.equal(pending.operation, "qa");
    assert.deepEqual(pending.inputs, firstReviewInput);
    assert.equal(pending.attempt, 1);
    assert.equal((await state.readLive()).task.id, task.id);

    await state.setControl("pause");
    assert.equal((await state.readControl()).pauseAfterCurrent, true);
    assert.equal((await state.readLive()).stage, "WAITING_FOR_LIMIT");
    await state.setControl("resume");
    const result = await loop;
    assert.equal(result.status, "done");
    assert.equal(clineRuns, 1, "Cline must not be relaunched for a QA resume");
    assert.equal(reviews, 2);
    assert.equal(assessments, 1);
  } finally {
    await loop.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("pending QA survives restart and Stop remains a safe recoverable state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-limit-restart-"));
  const stateDir = path.join(root, ".state");
  const state = new DashboardState({ stateDir });
  await state.initialize({ task, workspace: root, maxAttempts: 2 });
  let clineRuns = 0;
  const common = {
    prepareQa,
    workspace: root, stateDir, objective: "bounded", initialTask: task, maxAttempts: 2,
    codex: { activeCount: 0 }, reconcile: async()=>{}, baseline: async () => ({ head: "base" }), verify: async () => {}, pollMs: 10,
    readControl: () => state.readControl(), onEvent: (event) => state.record(event), onTask: async () => {},
    worker: { withExclusive: async (fn) => fn(), run: async () => { clineRuns++; return { exitCode: 0, output: "done" }; } },
    assess: async () => ({ status: "done" }),
  };
  let first, second;
  try {
    first = startTestLoop({ ...common, review: async () => { throw limitError(); } });
    await first.waitForEvent('waiting-for-codex');
    await state.setControl("stop");
    assert.equal((await first).status, "stopped");
    const pending = await readPendingCodex(stateDir);
    assert.equal(pending.operation, "qa");
    assert.equal(pending.attempt, 1);

    await atomicWriteJson(path.join(stateDir, "control.json"), {
      pauseAfterCurrent: false, stopAfterSafePoint: false, resumeGeneration: 0,
    });
    let reviews = 0;
    second = startTestLoop({
      ...common, initialTask: null, pendingCodex: pending,
      worker: { withExclusive: async (fn) => fn(), run: async () => { throw new Error("Cline must not run after restart"); } },
      review: async (input) => { reviews++; assert.deepEqual(input, pending.inputs); return { status: "pass", output: "pass", commit: "fake" }; },
    });
    await second.waitForEvent('waiting-for-codex');
    await state.setControl("resume");
    assert.equal((await second).status, "done");
    assert.equal(reviews, 1);
    assert.equal(clineRuns, 1);
  } finally { await first?.stop(); await second?.stop(); await rm(root, { recursive: true, force: true }); }
});

test("a Resume recorded while the worker is down is honored after restart", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-limit-offline-resume-"));
  const stateDir = path.join(root, ".state");
  const state = new DashboardState({ stateDir });
  await state.initialize({ task, workspace: root, maxAttempts: 2 });
  const inputs = { task, attempt: 3, baselineHead: "base", workerResult: { exitCode: 0, output: "done" } };
  const pending = {
    version: 1, operation: "qa", taskId: task.id, attempt: 3, inputs,
    context: { prompt: "same prompt", history: [] }, limit: { message: limitMessage, retryAt: "try again at 10:07 PM" },
    waitingResumeGeneration: 0,
  };
  await atomicWriteJson(path.join(stateDir, "pending-codex.json"), pending);
  await state.setControl("resume");
  let reviews = 0;
  try {
    const result = await runNodeLoop({
      workspace: root, stateDir, objective: "bounded", initialTask: null, pendingCodex: pending, maxAttempts: 2,
      codex: { activeCount: 0 },
      worker: { withExclusive: async (fn) => fn(), run: async () => { throw new Error("Cline must not run"); } },
      baseline: async () => ({ head: "wrong" }), verify: async () => {}, pollMs: 10,
      readControl: () => state.readControl(), onEvent: (event) => state.record(event), onTask: async () => {},
      review: async (actual) => { reviews++; assert.deepEqual(actual, inputs); return { status: "manual-review", manualReviewCause:"missing-permissions", output: "still broken", correction: "" }; },
      assess: async () => ({ status: "done" }),
    });
    assert.equal(result.status, "blocked");
    assert.equal(reviews, 1, "saved operation must resume exactly once before explicit manual review");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a Resume before the limit does not cause an automatic Codex retry", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-limit-no-auto-retry-"));
  const stateDir = path.join(root, ".state");
  const state = new DashboardState({ stateDir });
  await state.initialize({ task, workspace: root, maxAttempts: 2 });
  let reviews = 0;
  const loop = startTestLoop({
    prepareQa,
    workspace: root, stateDir, objective: "bounded", initialTask: task, maxAttempts: 2,
    codex: { activeCount: 0 },
    worker: { withExclusive: async (fn) => fn(), run: async () => ({ exitCode: 0, output: "done" }) },
    baseline: async () => ({ head: "base" }), verify: async () => {}, pollMs: 10,
    readControl: () => state.readControl(), onEvent: (event) => state.record(event), onTask: async () => {},
    review: async () => {
      reviews++;
      if (reviews === 1) { await state.setControl("resume"); throw limitError(); }
      return { status: "pass", output: "pass", commit: "fake" };
    },
    assess: async () => ({ status: "done" }),
  });
  try {
    await loop.waitForEvent('waiting-for-codex');
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.equal(reviews, 1, "Resume before WAITING must not trigger an automatic retry");
    await state.setControl("resume");
    assert.equal((await loop).status, "done");
    assert.equal(reviews, 2);
  } finally { await loop.stop(); await rm(root, { recursive: true, force: true }); }
});

test("assessment usage limit resumes the identical assessment before launching Cline", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-limit-assess-"));
  const stateDir = path.join(root, ".state");
  const state = new DashboardState({ stateDir });
  await state.initialize({ task: { id: "assessment", name: "Assessing", prompt: "bounded" }, workspace: root, maxAttempts: 2 });
  let assessments = 0;
  let clineRuns = 0;
  let firstInput;
  const loop = startTestLoop({
    prepareQa,
    workspace: root, stateDir, objective: "bounded", codex: { activeCount: 0 }, maxAttempts: 2,
    worker: { withExclusive: async (fn) => fn(), run: async () => { clineRuns++; return { exitCode: 0, output: "done" }; } },
    baseline: async () => ({ head: "base" }), verify: async () => {}, pollMs: 10,
    readControl: () => state.readControl(), onEvent: (event) => state.record(event),
    onTask: (next) => state.initialize({ task: next, workspace: root, maxAttempts: 2 }),
    assess: async (input) => {
      assessments++;
      firstInput ??= structuredClone(input);
      if (assessments <= 2) assert.deepEqual(input, firstInput);
      if (assessments === 1) throw limitError();
      return assessments === 2 ? { status: "task", task } : { status: "done" };
    },
    review: async () => ({ status: "pass", output: "pass", commit: "fake" }),
  });
  try {
    await loop.waitForEvent('waiting-for-codex');
    const waiting = await state.readLive();
    assert.equal(waiting.interruptedOperation, "assessment");
    assert.equal(clineRuns, 0);
    await state.setControl("resume");
    assert.equal((await loop).status, "done");
    assert.equal(assessments, 3);
    assert.equal(clineRuns, 1);
  } finally { await loop.stop(); await rm(root, { recursive: true, force: true }); }
});

test("pending assessment overrides a conflicting initial task on restart", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-limit-assess-restart-"));
  const stateDir = path.join(root, ".state");
  const state = new DashboardState({ stateDir });
  await state.initialize({ task: { id: "assessment", name: "Assessing", prompt: "same objective" }, workspace: root, maxAttempts: 2 });
  const inputs = { objective: "same objective", previous: null };
  const pending = {
    version: 1, operation: "assessment", taskId: null, attempt: null, inputs,
    context: { baselineHead: "base" }, limit: { message: limitMessage, retryAt: "try again at 10:07 PM" },
    waitingResumeGeneration: 0,
  };
  await state.setControl("resume");
  let assessments = 0;
  try {
    const result = await runNodeLoop({
      workspace: root, stateDir, objective: "different", initialTask: task, pendingCodex: pending, maxAttempts: 2,
      codex: { activeCount: 0 },
      worker: { withExclusive: async (fn) => fn(), run: async () => { throw new Error("conflicting task must not launch Cline"); } },
      baseline: async () => ({ head: "wrong" }), verify: async () => {}, pollMs: 10,
      readControl: () => state.readControl(), onEvent: (event) => state.record(event), onTask: async () => {},
      assess: async (actual) => { assessments++; assert.deepEqual(actual, inputs); return { status: "done" }; },
      review: async () => { throw new Error("QA must not run"); },
    });
    assert.equal(result.status, "done");
    assert.equal(assessments, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("legacy usage-limit manual review is recovered as exact pending QA inputs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-limit-legacy-"));
  const stateDir = path.join(root, ".state");
  const invocation = path.join(stateDir, "codex", "legacy");
  await mkdir(invocation, { recursive: true });
  const inputs = { task, attempt: 2, baselineHead: "abc", workerResult: { exitCode: 1, output: "existing Cline handoff" } };
  await writeFile(path.join(invocation, "prompt.txt"), `QA instructions\nINPUT: ${JSON.stringify(inputs)}`);
  await writeFile(path.join(invocation, "events.ndjson"), `${JSON.stringify({ type: "turn.failed", error: { message: limitMessage } })}\n`);
  await atomicWriteJson(path.join(stateDir, "current-task.json"), task);
  await atomicWriteJson(path.join(stateDir, "live.json"), {
    task, workspace: root, stage: "manual-review", clineStatus: "idle", qaStatus: "fail",
    attempt: 2, maxAttempts: 2, latestQa: "generic error", manualReview: true,
  });
  await atomicWriteJson(path.join(stateDir, "control.json"), {
    pauseAfterCurrent: false, stopAfterSafePoint: false, resumeGeneration: 4,
  });
  try {
    const pending = await recoverLegacyQaLimit({ stateDir });
    assert.equal(pending.operation, "qa");
    assert.deepEqual(pending.inputs, inputs);
    assert.equal(pending.attempt, 2);
    assert.equal(pending.waitingResumeGeneration, 4);
    const live = JSON.parse(await readFile(path.join(stateDir, "live.json"), "utf8"));
    assert.equal(live.stage, "WAITING_FOR_LIMIT");
    assert.equal(live.manualReview, false);
    assert.equal(live.attempt, 2);
    assert.equal(live.task.id, task.id);
  } finally { await rm(root, { recursive: true, force: true }); }
});

// Rev F14: unattended runs retried implementation limits by themselves, but stayed paused in Assessment, QA, Resolver and Elevation.
test("an unattended run retries an orchestration usage limit by itself after the retry interval", async (t) => {
  const { useRunLimits } = await import("../src/run-budget.mjs");
  useRunLimits({ unattended: true, limitRetryMinutes: 0.001 });
  t.after(() => useRunLimits({}));
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-limit-retry-"));
  const stateDir = path.join(root, ".state");
  const state = new DashboardState({ stateDir });
  await state.initialize({ task: { id: "assessment", name: "Assessing", prompt: "bounded" }, workspace: root, maxAttempts: 2 });
  let assessments = 0;
  const loop = startTestLoop({
    prepareQa,
    workspace: root, stateDir, objective: "bounded", codex: { activeCount: 0 }, maxAttempts: 2,
    worker: { withExclusive: async (fn) => fn(), run: async () => ({ exitCode: 0, output: "done" }) },
    baseline: async () => ({ head: "base" }), verify: async () => {}, pollMs: 10,
    readControl: () => state.readControl(), onEvent: (event) => state.record(event),
    onTask: (next) => state.initialize({ task: next, workspace: root, maxAttempts: 2 }),
    assess: async () => { assessments++; if (assessments === 1) throw limitError(); return { status: "done" }; },
    review: async () => ({ status: "pass", output: "pass", commit: "fake" }),
  });
  try {
    assert.equal((await loop).status, "done", "no Resume was pressed");
    assert.equal(assessments, 2);
    assert.ok((await state.readEvents(100)).some((e) => e.type === "orchestration-limit-resumed" && e.automatic === true));
  } finally { await loop.stop(); await rm(root, { recursive: true, force: true }); }
});
