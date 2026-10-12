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
  assert.equal(snapshot.stage, "cline-working");
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

test("QA evidence uses explicit categories and survives WAITING_FOR_CODEX", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "dashboard-state-"));
  const state = new DashboardState({ stateDir });
  await state.initialize({ task, workspace: "C:/fake", maxAttempts: 2 });
  const qaChecks = { tests: "PASS", typecheck: "NOT RUN", lint: "NOT RUN", build: "NOT RUN", scopeCheck: "FAIL" };
  await state.record({ type: "qa-evidence-finished", attempt: 1, qaChecks });
  await state.record({ type: "codex-usage-limit", operation: "qa", attempt: 1, message: "limit" });
  const live = await state.readLive();
  assert.deepEqual(live.qaChecks, qaChecks);
  assert.equal(live.stage, "WAITING_FOR_CODEX");
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
