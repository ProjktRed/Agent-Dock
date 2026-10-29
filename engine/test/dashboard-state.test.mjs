import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DashboardState } from "../src/dashboard-state.mjs";

const task = { id: "fake-task", name: "Fake task", prompt: "Implement the fake task" };

test("running fake task is represented in live state", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "dashboard-state-"));
  const state = new DashboardState({ stateDir });
  await state.initialize({ task, workspace: "C:/fake", maxAttempts: 3 });
  await state.record({ type: "cline-running", attempt: 2 });

  const snapshot = await state.readLive();
  assert.equal(snapshot.task.id, "fake-task");
  assert.equal(snapshot.task.name, "Fake task");
  assert.equal(snapshot.stage, "implementing");
  assert.equal(snapshot.clineStatus, "running");
  assert.equal(snapshot.qaStatus, "waiting");
  assert.equal(snapshot.attempt, 2);
  assert.equal(snapshot.maxAttempts, 3);
  await rm(stateDir, { recursive: true, force: true });
});

test("live state exposes configured Cline context and timeout", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "dashboard-state-"));
  const state = new DashboardState({ stateDir });
  await state.initialize({ task, workspace: "C:/fake", maxAttempts: null, contextTokens: 98_304, timeoutSeconds: 1_800, model: "glm-test", provider: "ollama" });
  const snapshot = await state.readLive();
  assert.deepEqual(snapshot.cline, {
    startedAt: null, finishedAt: null, durationMs: null, pid: null,
    contextTokens: 98_304, timeoutSeconds: 1_800, model: "glm-test", provider: "ollama",
  });
  await rm(stateDir, { recursive: true, force: true });
});

test("unlimited retry state has no numeric maximum", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "dashboard-state-"));
  const state = new DashboardState({ stateDir });
  await state.initialize({ task, workspace: "C:/fake", maxAttempts: null });
  await state.record({ type: "retry", attempt: 6, qa: "fifth strategy failed" });
  const snapshot = await state.readLive();
  assert.equal(snapshot.attempt, 6);
  assert.equal(snapshot.maxAttempts, null);
  await rm(stateDir, { recursive: true, force: true });
});

test("Cline process telemetry populates immediately and retains final elapsed duration", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "dashboard-state-"));
  const state = new DashboardState({ stateDir });
  await state.initialize({ task, workspace: "C:/fake", maxAttempts: 2 });
  const startedAt = "2026-09-13T12:00:00.000Z";
  await state.record({ type: "cline-started", attempt: 1, startedAt, pid: 4242 });
  let live = await state.readLive();
  assert.equal(live.cline.startedAt, startedAt);
  assert.equal(live.cline.pid, 4242);
  await state.record({ type: "cline-finished", attempt: 1, finishedAt: "2026-09-13T12:00:03.500Z", durationMs: 3500, exitCode: 0 });
  live = await state.readLive();
  assert.equal(live.cline.startedAt, startedAt);
  assert.equal(live.cline.durationMs, 3500);
  assert.equal(live.cline.pid, null);
  await rm(stateDir, { recursive: true, force: true });
});

test("QA evidence uses explicit categories and survives WAITING_FOR_LIMIT", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "dashboard-state-"));
  const state = new DashboardState({ stateDir });
  await state.initialize({ task, workspace: "C:/fake", maxAttempts: 2 });
  const qaChecks = { tests: "PASS", typecheck: "NOT RUN", lint: "NOT RUN", build: "NOT RUN", scopeCheck: "FAIL" };
  await state.record({ type: "qa-evidence-finished", attempt: 1, qaChecks });
  await state.record({ type: "codex-usage-limit", operation: "qa", attempt: 1, message: "limit" });
  const live = await state.readLive();
  assert.deepEqual(live.qaChecks, qaChecks);
  assert.equal(live.stage, "WAITING_FOR_LIMIT");
  await rm(stateDir, { recursive: true, force: true });
});

test("FAIL retry PASS transitions update QA and activity atomically", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "dashboard-state-"));
  const state = new DashboardState({ stateDir });
  await state.initialize({ task, workspace: "C:/fake", maxAttempts: 2 });
  await state.record({ type: "qa-running", attempt: 1 });
  await state.record({ type: "qa-fail", attempt: 1, qa: "broken output" });
  await state.record({ type: "retry", attempt: 2 });
  await state.record({ type: "qa-running", attempt: 2 });
  await state.record({ type: "qa-pass", attempt: 2, qa: "all checks pass" });

  const snapshot = await state.readLive();
  const events = await state.readEvents();
  assert.equal(snapshot.stage, "pass");
  assert.equal(snapshot.qaStatus, "pass");
  assert.equal(snapshot.attempt, 2);
  assert.equal(snapshot.latestQa, "all checks pass");
  assert.deepEqual(events.slice(-4).map((event) => event.type), [
    "qa-fail",
    "retry",
    "qa-running",
    "qa-pass",
  ]);
  assert.ok(events.every((event) => event.taskId === "fake-task"));
  JSON.parse(await readFile(path.join(stateDir, "live.json"), "utf8"));
  await rm(stateDir, { recursive: true, force: true });
});

test("resume reads the latest task state written by another process", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "dashboard-state-"));
  const serverState = new DashboardState({ stateDir });
  await serverState.initialize({ task, workspace: "C:/fake", maxAttempts: 2 });

  const workflowState = new DashboardState({ stateDir });
  const newerTask = { id: "new-task", name: "New task", prompt: "New prompt" };
  await workflowState.initialize({ task: newerTask, workspace: "C:/fake", maxAttempts: 2 });
  await workflowState.record({ type: "qa-pass", attempt: 1, qa: "new pass" });
  await workflowState.record({ type: "paused", attempt: 1, qa: "new pass" });

  await serverState.setControl("resume");
  const live = await workflowState.readLive();
  assert.equal(live.task.id, "new-task");
  assert.equal(live.stage, "pass");
  assert.equal(live.latestQa, "new pass");
  await rm(stateDir, { recursive: true, force: true });
});

test("pause resume and stop controls always leave valid JSON", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "dashboard-state-"));
  const state = new DashboardState({ stateDir });
  await state.initialize({ task, workspace: "C:/fake", maxAttempts: 2 });
  await state.record({ type: "qa-pass", attempt: 1, qa: "pass" });
  await state.setControl("pause");
  assert.deepEqual(await state.readControl(), {
    pauseAfterCurrent: true,
    stopAfterSafePoint: false,
    resumeGeneration: 0,
  });
  await state.record({ type: "paused", attempt: 1, qa: "pass" });
  assert.equal((await state.readLive()).stage, "paused");
  await state.setControl("resume");
  assert.deepEqual(await state.readControl(), {
    pauseAfterCurrent: false,
    stopAfterSafePoint: false,
    resumeGeneration: 1,
  });
  assert.equal((await state.readLive()).stage, "pass");
  await state.setControl("stop");
  assert.deepEqual(await state.readControl(), {
    pauseAfterCurrent: false,
    stopAfterSafePoint: true,
    resumeGeneration: 1,
  });
  JSON.parse(await readFile(path.join(stateDir, "control.json"), "utf8"));
  await rm(stateDir, { recursive: true, force: true });
});

test("live state saved with the old stage names reads with the current ones", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "dashboard-legacy-"));
  const { writeFile } = await import("node:fs/promises");
  try {
    for (const [old, current] of [["cline-working", "implementing"], ["cline-complete", "implemented"], ["codex-qa", "qa"], ["WAITING_FOR_CODEX", "WAITING_FOR_LIMIT"], ["BLOCKED", "BLOCKED"]]) {
      await writeFile(path.join(stateDir, "live.json"), JSON.stringify({ stage: old, task }));
      assert.equal((await new DashboardState({ stateDir }).readLive()).stage, current);
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("a fresh run's events before its first task are not filed under the last run's task", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "dashboard-state-"));
  try {
    const first = new DashboardState({ stateDir });
    await first.initialize({ task, workspace: "C:/fake", maxAttempts: 3 });
    await first.record({ type: "qa-pass", attempt: 1 });
    const next = new DashboardState({ stateDir });
    next.carryTask = false;
    await next.record({ type: "blocked", qa: "Assessment failed" });
    await next.initialize({ task: { id: "second", prompt: "x" }, workspace: "C:/fake", maxAttempts: 3 });
    await next.record({ type: "qa-pass", attempt: 1 });
    const resumed = new DashboardState({ stateDir });
    await resumed.record({ type: "control-resume" });
    const events = (await readFile(path.join(stateDir, "activity.ndjson"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(events.filter((e) => e.type !== "task-loaded").map((e) => [e.type, e.taskId]), [["qa-pass", "fake-task"], ["blocked", undefined], ["qa-pass", "second"], ["control-resume", "second"]]);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

// AD-06: one half-written last line made the dashboard's status and logs answer 400.
test("a half-written Activity line is skipped by every reader", async () => {
  const { mkdtemp, rm, appendFile } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = await mkdtemp(path.join(os.tmpdir(), "state-torn-"));
  try {
    const state = new DashboardState({ stateDir: dir });
    await state.record({ type: "assessment-started" });
    await appendFile(path.join(dir, "activity.ndjson"), '{"type":"qa-pa');
    assert.deepEqual((await state.readEvents(10)).map((e) => e.type), ["assessment-started"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('no event text is huge in activity or live state', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dashboard-clip-'));
  try {
    const { EVENT_TEXT_LIMIT } = await import('../src/dashboard-state.mjs');
    const state = new DashboardState({ stateDir: dir });
    await state.initialize({ task, workspace: "C:/fake", maxAttempts: 3 });
    await state.record({ type: 'blocked', qa: 'Changes outside allowedPaths: ' + 'node_modules/x.js, '.repeat(50_000) });
    const live = JSON.parse(await readFile(path.join(dir, 'live.json'), 'utf8'));
    assert.ok(live.latestQa.length <= EVENT_TEXT_LIMIT);
    assert.ok(live.blockedReason.length <= EVENT_TEXT_LIMIT);
    assert.match(live.latestQa, /characters left out/);
    const activity = await readFile(path.join(dir, 'activity.ndjson'), 'utf8');
    assert.ok(activity.length < EVENT_TEXT_LIMIT * 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("the manual-review classification reads the whole text, not the clipped one", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dashboard-classify-"));
  try {
    const state = new DashboardState({ stateDir: dir });
    await state.initialize({ task, workspace: "C:/fake", maxAttempts: 3 });
    await state.record({ type: "manual-review", qa: "a".repeat(11_000) + " permission denied " + "b".repeat(11_000) });
    const live = JSON.parse(await readFile(path.join(dir, "live.json"), "utf8"));
    assert.equal(live.stage, "BLOCKED");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a pending Codex receipt in live state is never clipped", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dashboard-receipt-"));
  try {
    const state = new DashboardState({ stateDir: dir });
    await state.initialize({ task, workspace: "C:/fake", maxAttempts: 3 });
    const big = "d".repeat(60_000);
    await state.record({ type: "recovery-state", recovery: { codexOperation: { id: "op", result: big } } });
    const live = JSON.parse(await readFile(path.join(dir, "live.json"), "utf8"));
    assert.equal(live.codexOperation.result.length, big.length);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
