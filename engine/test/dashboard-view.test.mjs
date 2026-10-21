import assert from "node:assert/strict";
import test from "node:test";

import { dashboardFields, dashboardView } from "../ui/view-model.js";
import * as viewModel from "../ui/view-model.js";

test("auto-compaction statuses cannot replace the latest useful Cline message or action", () => {
  const message = "Reading the lifecycle harness";
  const events = [
    { type: "cline-message", message, action: message },
    ...["auto-compacting", "auto-compacted", "auto-compaction-skipped"].map((message) => ({ type: "cline-message", message, action: message })),
  ];
  const original = structuredClone(events);
  const view = dashboardView({ stage: "implementing", clineStatus: "running", events });
  assert.equal(view.activity.latestMessage, message);
  assert.equal(view.activity.currentAction, message);
  assert.deepEqual(events, original, "Display filtering must not change stored events");
});

test("dashboard event history hides old and new compaction statuses but preserves useful events in arrival order", () => {
  const useful = [
    { type: "cline-command-started", message: "auto-compacting", commands: ["npm test"] },
    { type: "cline-file-read", path: "auto-compacted.txt" },
    { type: "cline-message", message: "Investigating why auto-compaction-skipped was reported" },
    { type: "qa-fail", qa: "auto-compacted" },
  ];
  const events = [
    { type: "cline-message", message: "auto-compacting", timestamp: "2026-09-19T12:00:00Z" },
    useful[0], useful[1],
    { type: "cline-message", message: "auto-compacted" },
    useful[2],
    { type: "cline-message", message: " auto-compaction-skipped " },
    useful[3],
  ];
  const original = structuredClone(events);
  assert.equal(typeof viewModel.dashboardEvents, "function");
  assert.deepEqual(viewModel.dashboardEvents(events), useful);
  assert.deepEqual(viewModel.dashboardEvents(events).slice().reverse(), useful.slice().reverse());
  assert.deepEqual(events, original);
});

test("a dashboard with only auto-compaction events uses honest activity fallbacks", () => {
  const view = dashboardView({ clineStatus: "running", events: [{ type: "cline-message", message: "auto-compacted" }] });
  assert.equal(view.activity.latestMessage, "N/A");
  assert.equal(view.activity.currentAction, "Cline is implementing the current task");
});

test("dashboard fields render API Cline telemetry and explicit QA states without inference", () => {
  const fields = dashboardFields({
    cline: { startedAt: "2026-09-13T12:00:00.000Z", elapsedMs: 65_000, pid: 4242 },
    qaChecks: { tests: "PASS", typecheck: "NOT RUN", lint: "INCONCLUSIVE", scopeCheck: "FAIL" },
  });
  assert.equal(fields.clineElapsed, "01:05");
  assert.equal(fields.clinePid, "4242");
  assert.deepEqual(fields.qaChecks, { tests: "PASS", typecheck: "NOT RUN", lint: "INCONCLUSIVE", scopeCheck: "FAIL" });
});

test("dashboard fields format configured context and timeout without inventing values", () => {
  const configured = dashboardFields({ cline: { contextTokens: 98_304, timeoutSeconds: 1_800 } });
  assert.equal(configured.clineContext, "98,304 tokens");
  assert.equal(configured.clineTimeout, "30 min");
  const missing = dashboardFields({ cline: {} });
  assert.equal(missing.clineContext, "—");
  assert.equal(missing.clineTimeout, "—");
});

test("running Cline state maps to implementation workflow and honest activity fallbacks", () => {
  const view = dashboardView({
    task: { id: "P1-008", name: "Campaign status", prompt: "Improve freshness" },
    stage: "implementing", clineStatus: "running", qaStatus: "waiting", attempt: 2,
    maxAttempts: null, changedFiles: [{ status: "M", path: "src/campaign.js" }],
    events: [
      { type: "cline-started", timestamp: "2026-09-13T12:00:00Z" },
      { type: "qa-evidence-started", timestamp: "2026-09-13T12:01:00Z", commands: ["npm test"] },
    ],
  });
  assert.equal(view.activeStep, "implement");
  assert.equal(view.phase, "Current task");
  assert.equal(view.attempt, "Attempt 2");
  assert.equal(view.progress.label, "Implementation in progress");
  assert.equal(view.progress.percent, null);
  assert.equal(view.activity.currentAction, "Cline is implementing the current task");
  assert.equal(view.activity.lastCommand, "npm test");
  assert.equal(view.activity.lastFileRead, "N/A");
  assert.equal(view.activity.lastFileModified, "N/A");
  assert.equal(view.changedFiles[0].path, "src/campaign.js");
});

test("dashboard view distinguishes all supported lifecycle states", () => {
  const cases = [
    ["implementing", "running", "waiting", false, "implement", "Running"],
    ["qa", "idle", "running", false, "qa", "Running"],
    ["pass", "idle", "pass", false, "complete", "Complete"],
    ["fail", "idle", "fail", false, "qa", "Failed"],
    ["retry", "idle", "waiting", false, "implement", "Retrying"],
    ["WAITING_FOR_LIMIT", "idle", "waiting-for-codex", false, "qa", "Waiting for usage limit"],
    ["paused", "idle", "waiting", false, "implement", "Paused"],
    ["manual-review", "idle", "fail", true, "qa", "User Attention"],
    ["waiting", "idle", "waiting", false, "implement", "Waiting"],
  ];
  for (const [stage, clineStatus, qaStatus, manualReview, activeStep, primaryLabel] of cases) {
    const view = dashboardView({ stage, clineStatus, qaStatus, manualReview, task: null, events: [] });
    assert.equal(view.activeStep, activeStep, stage);
    assert.equal(view.primaryLabel, primaryLabel, stage);
  }
});

test("QA checks and unavailable task metadata use explicit non-invented labels", () => {
  const view = dashboardView({
    task: { id: "T-1", name: "Task" }, stage: "qa", qaStatus: "running",
    qaChecks: { tests: "PASS", scopeCheck: "RUNNING" }, events: [],
  });
  assert.deepEqual(view.qaChecks, {
    tests: "PASS", typecheck: "NOT RUN", lint: "NOT RUN", build: "NOT RUN", scopeCheck: "RUNNING",
  });
  assert.equal(view.task.description, "N/A");
  assert.equal(view.task.priority, "N/A");
  assert.equal(view.task.baselineSha, "—");
  assert.equal(view.task.currentSha, "—");
});

test("activity uses real structured event details when available", () => {
  const view = dashboardView({
    stage: "implementing", clineStatus: "running", events: [
      { type: "cline-file-read", path: "schema.ts", timestamp: "2026-09-13T12:00:00Z" },
      { type: "cline-file-modified", path: "service.ts", timestamp: "2026-09-13T12:00:01Z" },
      { type: "cline-message", message: "Updating freshness logic", timestamp: "2026-09-13T12:00:02Z" },
    ],
  });
  assert.equal(view.activity.lastFileRead, "schema.ts");
  assert.equal(view.activity.lastFileModified, "service.ts");
  assert.equal(view.activity.latestMessage, "Updating freshness logic");
});

test("all ten requested fake dashboard states render explicit labels", () => {
  const states = [
    ["Cline Running", { stage: "implementing", clineStatus: "running", qaStatus: "waiting" }, "Running", "NOT RUN"],
    ["Cline Finished to QA Running", { stage: "qa", clineStatus: "idle", qaStatus: "running", qaChecks: { tests: "RUNNING" } }, "Running", "RUNNING"],
    ["QA PASS", { stage: "pass", clineStatus: "idle", qaStatus: "pass", qaChecks: { tests: "PASS" } }, "Complete", "PASS"],
    ["QA FAIL", { stage: "fail", clineStatus: "idle", qaStatus: "fail", qaChecks: { tests: "FAIL" } }, "Failed", "FAIL"],
    ["QA INCONCLUSIVE", { stage: "fail", clineStatus: "idle", qaStatus: "fail", qaChecks: { tests: "INCONCLUSIVE" } }, "Failed", "INCONCLUSIVE"],
    ["Retry attempt", { stage: "retry", clineStatus: "idle", qaStatus: "waiting", attempt: 2 }, "Retrying", "NOT RUN"],
    ["WAITING_FOR_LIMIT", { stage: "WAITING_FOR_LIMIT", interruptedOperation: "qa", qaStatus: "waiting-for-codex" }, "Waiting for usage limit", "NOT RUN"],
    ["Paused", { stage: "paused", clineStatus: "idle", qaStatus: "waiting" }, "Paused", "NOT RUN"],
    ["User Attention", { stage: "manual-review", manualReview: true, qaStatus: "fail" }, "User Attention", "NOT RUN"],
    ["Idle", { stage: "waiting", clineStatus: "idle", qaStatus: "waiting", task: null }, "Waiting", "NOT RUN"],
  ];
  for (const [name, state, primary, tests] of states) {
    const view = dashboardView({ events: [], ...state });
    assert.equal(view.primaryLabel, primary, name);
    assert.equal(view.qaChecks.tests, tests, name);
  }
});
