import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DashboardState } from "../src/dashboard-state.mjs";
import { runTask } from "../src/workflow.mjs";

const task = {
  id: "fake-loop",
  name: "Fake loop",
  prompt: "Implement fake work",
  qaCommand: "fake qa",
  allowedPaths: ["fake.txt"],
};

test("fake worker FAIL retry PASS updates dashboard state", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "dashboard-flow-"));
  const state = new DashboardState({ stateDir });
  await state.initialize({ task, workspace: stateDir, maxAttempts: 2 });
  let qaAttempt = 0;

  const result = await runTask({
    task,
    maxAttempts: 2,
    worker: {
      isBusy: async () => false,
      run: async () => ({ exitCode: 0, output: "fake worker complete" }),
    },
    runQa: async () => {
      qaAttempt += 1;
      return qaAttempt === 1
        ? { pass: false, output: "fake QA failure" }
        : { pass: true, output: "fake QA pass" };
    },
    onEvent: (event) => state.record(event),
  });

  const live = await state.readLive();
  assert.equal(result.status, "passed");
  assert.equal(live.stage, "pass");
  assert.equal(live.qaStatus, "pass");
  assert.equal(live.attempt, 2);
  assert.equal(live.latestQa, "fake QA pass");
  await rm(stateDir, { recursive: true, force: true });
});

test("stop request at an already-safe point does not launch Cline", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "dashboard-flow-"));
  const state = new DashboardState({ stateDir });
  await state.initialize({ task, workspace: stateDir, maxAttempts: 2 });
  await state.setControl("stop");
  let runs = 0;

  const result = await runTask({
    task,
    maxAttempts: 2,
    worker: {
      isBusy: async () => false,
      run: async () => {
        runs += 1;
        return { exitCode: 0, output: "fake worker complete" };
      },
    },
    runQa: async () => {
      throw new Error("QA must not run after a safe-point stop");
    },
    onEvent: (event) => state.record(event),
    shouldStop: async () => (await state.readControl()).stopAfterSafePoint,
  });

  const live = await state.readLive();
  assert.equal(result.status, "stopped");
  assert.equal(result.attempts, 0);
  assert.equal(runs, 0);
  assert.equal(live.stage, "stopped");
  assert.equal(live.attempt, 0);
  await rm(stateDir, { recursive: true, force: true });
});

test("stop requested during Cline work waits for the next QA safe point", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "dashboard-flow-"));
  const state = new DashboardState({ stateDir });
  await state.initialize({ task, workspace: stateDir, maxAttempts: 2 });
  let runs = 0;

  const result = await runTask({
    task,
    maxAttempts: 2,
    worker: {
      isBusy: async () => false,
      run: async () => {
        runs += 1;
        await state.setControl("stop");
        return { exitCode: 0, output: "fake worker complete" };
      },
    },
    runQa: async () => ({ pass: false, output: "fake QA failure" }),
    onEvent: (event) => state.record(event),
    shouldStop: async () => (await state.readControl()).stopAfterSafePoint,
  });

  const live = await state.readLive();
  assert.equal(result.status, "stopped");
  assert.equal(result.attempts, 1);
  assert.equal(runs, 1);
  assert.equal(live.stage, "stopped");
  assert.equal(live.latestQa, "fake QA failure");
  await rm(stateDir, { recursive: true, force: true });
});
