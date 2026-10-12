import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DashboardState } from "../src/dashboard-state.mjs";
import { readPendingCodex, runRecoverableCodex } from "../src/node-loop.mjs";

const inputs = { task: { id: "resume" }, attempt: 2, diff: { bytes: 12 }, changedFiles: ["one.js"] };
const result = { status: "fail", output: "still broken", correction: "change one.js" };
const noControl = async () => ({ resumeGeneration: 0 });

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-resume-crash-"));
  const state = new DashboardState({ stateDir: root });
  await state.initialize({ task: inputs.task, workspace: root, maxAttempts: 2 });
  return { root, state };
}

const operation = (root, overrides = {}) => runRecoverableCodex({
  stateDir: root,
  operation: "qa",
  inputs,
  context: { task: inputs.task, prompt: "same prompt", history: [] },
  invoke: async () => result,
  emit: async () => {},
  readControl: noControl,
  pollMs: 1,
  ...overrides,
});

test("crash before live completion write leaves a completed resumable operation", async () => {
  const { root, state } = await fixture();
  try {
    await assert.rejects(operation(root, {
      emit: async (type, fields) => {
        if (type === "codex-qa-finished") throw new Error("simulated live write crash");
        await state.record({ type, ...fields });
      },
    }), /simulated live write crash/);

    const pending = await readPendingCodex(root);
    assert.equal(pending.status, "completed");
    assert.deepEqual(pending.result, result);
    assert.equal((await state.readLive()).codexOperation, null);

    let invocations = 0;
    const resumed = await operation(root, {
      pending,
      invoke: async () => { invocations++; throw new Error("completed operation must not rerun"); },
      emit: (type, fields) => state.record({ type, ...fields }),
    });
    assert.deepEqual(resumed.result, result);
    assert.equal(invocations, 0);
    assert.equal((await state.readLive()).codexOperation.status, "completed");
    await assert.rejects(access(path.join(root, "pending-codex.json")), /ENOENT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("crash after live completion write but before pending deletion reconciles without rerunning Codex", async () => {
  const { root, state } = await fixture();
  let removals = 0;
  try {
    await assert.rejects(operation(root, {
      emit: (type, fields) => state.record({ type, ...fields }),
      removePending: async () => { removals++; throw new Error("simulated cleanup crash"); },
    }), /simulated cleanup crash/);
    assert.equal(removals, 1);
    assert.equal((await state.readLive()).codexOperation.status, "completed");
    const pending = await readPendingCodex(root);
    assert.equal(pending.status, "completed");

    let invocations = 0;
    const resumed = await operation(root, {
      pending,
      invoke: async () => { invocations++; throw new Error("must not rerun"); },
      emit: (type, fields) => state.record({ type, ...fields }),
    });
    assert.deepEqual(resumed.result, result);
    assert.equal(invocations, 0);
    await assert.rejects(access(path.join(root, "pending-codex.json")), /ENOENT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("successful completion is reflected in live state before pending cleanup", async () => {
  const { root, state } = await fixture();
  const order = [];
  try {
    const completed = await operation(root, {
      emit: async (type, fields) => {
        await state.record({ type, ...fields });
        if (type === "codex-qa-finished") order.push("live");
      },
      removePending: async (file) => {
        assert.equal((await state.readLive()).codexOperation.status, "completed");
        order.push("remove");
        await rm(file, { force: true });
      },
    });
    assert.deepEqual(completed.result, result);
    assert.deepEqual(order, ["live", "remove"]);
    await assert.rejects(access(path.join(root, "pending-codex.json")), /ENOENT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("restart recovers a completed operation from live state when pending cleanup already finished", async () => {
  const { root, state } = await fixture();
  try {
    await operation(root, { emit: (type, fields) => state.record({ type, ...fields }) });
    await assert.rejects(access(path.join(root, "pending-codex.json")), /ENOENT/);
    const recovered = await readPendingCodex(root);
    assert.equal(recovered.status, "completed");
    assert.deepEqual(recovered.result, result);
    assert.deepEqual(recovered.inputs, inputs);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("completed assessment remains recoverable while its selected task is initialized", async () => {
  const { root, state } = await fixture();
  const assessedTask = { id: "selected", name: "Selected", prompt: "implement", qaCommand: "fake", allowedPaths: ["one.js"] };
  try {
    await runRecoverableCodex({
      stateDir: root,
      operation: "assessment",
      inputs: { objective: "bounded" },
      context: { baselineHead: "base" },
      invoke: async () => ({ status: "task", task: assessedTask }),
      emit: (type, fields) => state.record({ type, ...fields }),
      readControl: noControl,
      pollMs: 1,
    });
    await state.initialize({ task: assessedTask, workspace: root, maxAttempts: 2 });
    const recovered = await readPendingCodex(root);
    assert.equal(recovered.status, "completed");
    assert.deepEqual(recovered.result, { status: "task", task: assessedTask });
  } finally { await rm(root, { recursive: true, force: true }); }
});
