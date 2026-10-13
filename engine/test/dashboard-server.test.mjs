import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { primaryStatus, startDashboardServer } from "../src/dashboard-server.mjs";
import { atomicWriteJson, DashboardState } from "../src/dashboard-state.mjs";

async function fixture({ onControl } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dashboard-server-"));
  const stateDir = path.join(root, ".state");
  const workspace = path.join(root, "workspace");
  await writeFile(path.join(root, "placeholder"), "");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));
  execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
  await writeFile(path.join(workspace, "one.txt"), "changed\n");
  const state = new DashboardState({ stateDir });
  await state.initialize({
    task: { id: "server-task", name: "Server task", prompt: "Fake running task" },
    workspace,
    maxAttempts: 2,
  });
  await state.record({ type: "cline-running", attempt: 1 });
  const dashboard = await startDashboardServer({ stateDir, workspace, port: 0, onControl });
  return { root, stateDir, state, dashboard };
}

test("status API displays a running fake task and changed-file count", async () => {
  const { root, dashboard } = await fixture();
  const response = await fetch(`${dashboard.url}/api/status`);
  const status = await response.json();

  assert.equal(response.status, 200);
  assert.equal(status.task.id, "server-task");
  assert.equal(status.stage, "cline-working");
  assert.equal(status.clineStatus, "running");
  assert.equal(status.qaStatus, "waiting");
  assert.equal(status.attempt, 1);
  assert.equal(status.maxAttempts, 2);
  assert.equal(status.changedFilesCount, 1);
  assert.deepEqual(status.changedFiles, [{ status: "??", path: "one.txt" }]);
  assert.equal(status.currentSha, null);
  await dashboard.close();
  await rm(root, { recursive: true, force: true });
});

test("status API exposes the same Cline and QA values used by the dashboard", async () => {
  const { root, state, dashboard } = await fixture();
  await state.record({ type: "cline-started", attempt: 1, startedAt: "2026-09-13T12:00:00.000Z", pid: 5151 });
  await state.record({ type: "qa-evidence-finished", attempt: 1, qaChecks: { tests: "PASS", typecheck: "NOT RUN", lint: "FAIL", build: "NOT RUN", scopeCheck: "PASS" } });
  const status = await fetch(`${dashboard.url}/api/status`).then((response) => response.json());
  assert.equal(status.cline.pid, 5151);
  assert.equal(status.cline.startedAt, "2026-09-13T12:00:00.000Z");
  assert.equal(status.qaChecks.typecheck, "NOT RUN");
  assert.equal(status.qaChecks.lint, "FAIL");
  await dashboard.close();
  await rm(root, { recursive: true, force: true });
});

test("status API derives increasing elapsed time while Cline runs", async () => {
  const { root, state, dashboard } = await fixture();
  const startedAt = new Date(Date.now() - 2_000).toISOString();
  await state.record({ type: "cline-started", attempt: 1, startedAt, pid: 6161 });
  const first = await fetch(`${dashboard.url}/api/status`).then((response) => response.json());
  await new Promise((resolve) => setTimeout(resolve, 25));
  const second = await fetch(`${dashboard.url}/api/status`).then((response) => response.json());
  assert.ok(first.cline.elapsedMs >= 1_900);
  assert.ok(second.cline.elapsedMs > first.cline.elapsedMs);
  await dashboard.close();
  await rm(root, { recursive: true, force: true });
});

test("control API pauses resumes and requests a safe stop", async () => {
  const { root, state, dashboard } = await fixture();
  for (const action of ["pause", "resume", "stop"]) {
    const response = await fetch(`${dashboard.url}/api/control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action }),
    });
    assert.equal(response.status, 200);
  }

  assert.deepEqual(await state.readControl(), {
    pauseAfterCurrent: false,
    stopAfterSafePoint: true,
    resumeGeneration: 1,
  });
  await dashboard.close();
  await rm(root, { recursive: true, force: true });
});

test("activity history clear removes old rows without changing task, QA, or controls", async () => {
  const { root, state, dashboard } = await fixture();
  try {
    await state.record({ type: "manual-review", qa: "Needs evidence", attempt: 2 });
    await state.setControl("pause");
    const liveBefore = await state.readLive();
    const controlBefore = await state.readControl();
    assert.ok((await state.readEvents()).length > 0);
    const response = await fetch(`${dashboard.url}/api/activity/clear`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(response.status, 200);
    assert.deepEqual(await state.readEvents(), []);
    assert.deepEqual(await state.readLive(), liveBefore);
    assert.deepEqual(await state.readControl(), controlBefore);
    const status = await fetch(`${dashboard.url}/api/status`).then((result) => result.json());
    assert.equal(status.stage, "USER_ATTENTION");
    assert.equal(status.latestQa, "Needs evidence");
    assert.deepEqual(status.events, []);
  } finally { await dashboard.close(); await rm(root, { recursive: true, force: true }); }
});

test("activity history clear is refused while Cline is running", async () => {
  const { root, state, dashboard } = await fixture();
  try {
    const liveBefore = await state.readLive();
    const response = await fetch(`${dashboard.url}/api/activity/clear`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.notEqual(response.status, 200);
    assert.ok((await state.readEvents()).length > 0);
    assert.deepEqual(await state.readLive(), liveBefore);
  } finally { await dashboard.close(); await rm(root, { recursive: true, force: true }); }
});

test("pause-after-current remains WORKING until the task reaches paused state", async () => {
  const { root, state, dashboard } = await fixture();
  await state.setControl("pause");
  let status = await fetch(`${dashboard.url}/api/status`).then((response) => response.json());
  assert.equal(status.primaryStatus, "working");

  await state.record({ type: "paused", attempt: 1 });
  status = await fetch(`${dashboard.url}/api/status`).then((response) => response.json());
  assert.equal(status.primaryStatus, "paused");
  await dashboard.close();
  await rm(root, { recursive: true, force: true });
});

test("stopped stage takes precedence over waiting, pass, and fail QA badges", () => {
  for (const qaStatus of ["waiting", "pass", "fail"]) {
    assert.equal(
      primaryStatus({ stage: "stopped", qaStatus, clineStatus: "idle" }, {}),
      "stopped",
    );
  }
});

test("dashboard page exposes only the requested controls", async () => {
  const { root, dashboard } = await fixture();
  try {
    const html = await fetch(dashboard.url).then((response) => response.text());
    for (const control of ["Pause After Task", "Resume", "Stop After Current Task", "Elevate", "View Logs", "View Task Details"]) assert.match(html, new RegExp(control));
    for (const label of ["Agent Dock", "Overview", "Activity Log", "File Changes", "Cline Activity", "Recent Cline Events", "Tests &amp; Commands", "Task Details"]) assert.ok(html.includes(label), label);
    for (const id of ["cline-started", "cline-elapsed", "cline-pid", "qa-tests", "qa-typecheck", "qa-lint", "qa-scope", "current-action", "last-command", "last-file-read", "last-file-modified", "latest-message", "recent-events", "changed-files", "command-results", "activity-filter"]) assert.match(html, new RegExp(`id="${id}"`));
  } finally {
    await dashboard.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("manual-review status exposes Elevate and the control callback fires once", async () => {
  let launches = 0;
  const run = await fixture({ onControl: async (action) => { if (action === "elevate") launches++; } });
  try {
    const task = { id: "server-task", name: "Server task", prompt: "Fake task", qaCommand: "fake qa", allowedPaths: ["one.txt"] };
    const packet = { task, attempt: 1, baselineSha: "base", changedFiles: ["one.txt"], diff: { bytes: 4, patch: "diff" }, qaEvidence: { command: { command: "fake qa" } } };
    await atomicWriteJson(path.join(run.stateDir, "current-task.json"), task);
    await atomicWriteJson(path.join(run.stateDir, "qa-packet.json"), packet);
    await atomicWriteJson(path.join(run.stateDir, "last-result.json"), { task, result: { qa: { status: "manual-review", output: "failed", manualReviewCause: "implementation-strategy" }, history: [] } });
    await run.state.record({ type: "manual-review", attempt: 1, qa: "failed" });
    const status = await fetch(`${run.dashboard.url}/api/status`).then((response) => response.json());
    assert.equal(status.elevateAvailable, true);
    const response = await fetch(`${run.dashboard.url}/api/control`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "elevate" }),
    });
    assert.equal(response.status, 200);
    assert.equal(launches, 1);
    assert.equal((await run.state.readLive()).elevateRunning, true);
  } finally {
    await run.dashboard.close();
    await rm(run.root, { recursive: true, force: true });
  }
});

test("dashboard refuses cross-site, rebound-host and non-JSON write requests", async () => {
  const { root, state, dashboard } = await fixture();
  try {
    const { port } = new URL(dashboard.url);
    const { request } = await import("node:http");
    const send = (method, pathname, headers, body) => new Promise((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, method, path: pathname, headers }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
      req.on("error", reject);
      req.end(body);
    });
    const controlBefore = await state.readControl();
    const json = { "content-type": "application/json" };
    const pause = JSON.stringify({ action: "pause" });
    assert.equal(await send("GET", "/api/status", { host: `attacker.example:${port}` }), 403);
    assert.equal(await send("POST", "/api/control", { "content-type": "text/plain" }, pause), 403);
    assert.equal(await send("POST", "/api/control", { ...json, origin: "https://attacker.example" }, pause), 403);
    assert.equal(await send("POST", "/api/control", { ...json, "sec-fetch-site": "cross-site" }, pause), 403);
    assert.deepEqual(await state.readControl(), controlBefore);
    assert.equal(await send("GET", "/api/status", { host: `localhost:${port}` }), 200);
    assert.equal(await send("POST", "/api/control", { ...json, origin: `http://127.0.0.1:${port}`, "sec-fetch-site": "same-origin" }, pause), 200);
  } finally { await dashboard.close(); await rm(root, { recursive: true, force: true }); }
});
