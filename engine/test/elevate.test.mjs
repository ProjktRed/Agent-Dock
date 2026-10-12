import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { atomicWriteJson, DashboardState } from "../src/dashboard-state.mjs";
import {
  computeElevateFingerprint,
  elevateAvailability,
  loadElevateCase,
  runManualElevate,
} from "../src/manual-elevate.mjs";
import { CodexUsageLimitError } from "../src/codex-worker.mjs";

const task = { id: "T-7", name: "Bounded task", prompt: "Fix X", qaCommand: "npm.cmd test", allowedPaths: ["x.js"] };
const packet = {
  task, objective: "Fix X", acceptanceCriteria: ["X works"], baselineSha: "base", attempt: 2,
  changedFiles: ["x.js"], diff: { bytes: 18, patch: "diff --git a/x.js b/x.js" },
  clineSummary: { exitCode: 0, finishReason: "done", text: "changed X" },
  qaEvidence: { command: { command: "npm.cmd test", exitCode: 1 }, categories: { tests: "FAIL", scopeCheck: "PASS" } },
};

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "manual-elevate-"));
  const state = new DashboardState({ stateDir: root });
  await state.initialize({ task, workspace: root, maxAttempts: 2 });
  await atomicWriteJson(path.join(root, "current-task.json"), task);
  await atomicWriteJson(path.join(root, "qa-packet.json"), packet);
  await atomicWriteJson(path.join(root, "last-result.json"), {
    task,
    result: {
      status: "manual-review", attempts: 2,
      qa: { status: "manual-review", output: "Lifecycle evidence is inconclusive", manualReviewCause: "implementation-strategy" },
      history: [{ attempt: 1, qa: { correction: "Inspect handle A" } }, { attempt: 2, qa: { correction: "Inspect handle B" } }],
    },
  });
  await state.record({ type: "manual-review", attempt: 2, qa: "Lifecycle evidence is inconclusive" });
  return { root, state, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("Elevate availability requires an idle manual-review case with task and QA evidence", () => {
  const fingerprint = "fp";
  assert.equal(elevateAvailability({ live: { stage: "manual-review", manualReview: true, task, latestQa: "failed", clineStatus: "idle", qaStatus: "fail" }, fingerprint }).available, true);
  for (const live of [
    { stage: "waiting", task, latestQa: "failed" },
    { stage: "manual-review", manualReview: true, task: null, latestQa: "failed" },
    { stage: "manual-review", manualReview: true, task, latestQa: "" },
    { stage: "manual-review", manualReview: true, task, latestQa: "failed", clineStatus: "running" },
    { stage: "manual-review", manualReview: true, task, latestQa: "failed", qaStatus: "running" },
    { stage: "manual-review", manualReview: true, task, latestQa: "failed", elevateRunning: true },
    { stage: "manual-review", manualReview: true, task, latestQa: "failed", elevateUsedForFingerprint: fingerprint },
  ]) assert.equal(elevateAvailability({ live, fingerprint }).available, false);
});

test("fingerprint covers task, QA packet/verdict, diff, failure, and correction history", () => {
  const value = { task, qaPacket: packet, qaVerdict: { output: "bad" }, diff: packet.diff, failureReason: "bad", correctionHistory: ["one"] };
  const original = computeElevateFingerprint(value);
  for (const [key, changed] of [
    ["task", { ...task, prompt: "different" }],
    ["qaPacket", { ...packet, attempt: 3 }],
    ["qaVerdict", { output: "worse" }],
    ["diff", { ...packet.diff, patch: "different" }],
    ["failureReason", "different"],
    ["correctionHistory", ["two"]],
  ]) assert.notEqual(computeElevateFingerprint({ ...value, [key]: changed }), original, key);
});

test("Dashboard control accepts Elevate once and a changed fingerprint permits it again", async () => {
  const run = await fixture();
  try {
    const first = await run.state.setControl("elevate");
    assert.equal(first.elevateGeneration, 1);
    let live = await run.state.readLive();
    assert.equal(live.elevateRunning, true);
    assert.equal(live.elevateUsedForFingerprint, first.elevateFingerprint);
    await assert.rejects(run.state.setControl("elevate"), /not available/i);

    await run.state.record({ type: "elevate-result", elevateResult: { kind: "manual-review", label: "Remain manual review" } });
    const qa = { ...packet, diff: { ...packet.diff, patch: "new diff" } };
    await atomicWriteJson(path.join(run.root, "qa-packet.json"), qa);
    const second = await run.state.setControl("elevate");
    assert.equal(second.elevateGeneration, 2);
    assert.notEqual(second.elevateFingerprint, first.elevateFingerprint);
    live = await run.state.readLive();
    assert.equal(live.elevateRunning, true);
  } finally { await run.cleanup(); }
});

test("manual Elevate shares the strategy engine and launches worker before independent QA", async t => {
  const {harness,correction}=await import('../fixtures/recovery-harness.mjs');
  const {options,seed,state}=await harness(t);await seed();const order=[];
  const result=await runManualElevate({...options,initialTask:null,
    elevate:async input=>{assert.ok(input.qaPacket);order.push('astra-exit');return correction('strategy-revised');},
    worker:{withExclusive:fn=>fn(),run:async(p,h)=>{order.push('worker');await h.onStart({pid:1});return{exitCode:0};}},
    review:async()=>{order.push('qa');return{status:'pass',output:'verified',commit:'x'};}
  });
  assert.equal(result.status,'passed');assert.deepEqual(order,['astra-exit','worker','qa']);assert.equal((await state.readLive()).correctionCount,3);
});
test("manual Elevate cannot bypass unsafe review",async t=>{
  const {harness}=await import('../fixtures/recovery-harness.mjs');const {options,seed}=await harness(t);
  await seed({failure:{status:'manual-review',manualReviewCause:'missing-permissions',output:'permission denied'}});
  const result=await runManualElevate({...options,initialTask:null,elevate:()=>assert.fail()});assert.equal(result.status,'blocked');
});
