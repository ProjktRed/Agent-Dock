import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CodexUsageLimitError } from "../src/codex-worker.mjs";
import { DashboardState } from "../src/dashboard-state.mjs";
import { readPendingCodex, runNodeLoop } from "../src/node-loop.mjs";

function git(cwd, ...args) { return execFileSync("git", args, { cwd, encoding: "utf8" }).trim(); }
async function waitUntil(fn) {
  for (let index = 0; index < 500; index++) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out");
}

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "qa-packet-loop-"));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  git(workspace, "init"); git(workspace, "config", "user.email", "test@example.invalid"); git(workspace, "config", "user.name", "Test");
  await writeFile(path.join(workspace, "result.txt"), "before\n");
  git(workspace, "add", "."); git(workspace, "commit", "-m", "baseline");
  const task = { id: "T", name: "T", prompt: "Change result", acceptanceCriteria: ["result changed"], qaCommand: "node --version", allowedPaths: ["result.txt"] };
  const stateDir = path.join(root, ".state");
  const state = new DashboardState({ stateDir });
  await state.initialize({ task, workspace, maxAttempts: 2 });
  return { root, workspace, stateDir, state, task };
}

test("usage-limited QA resumes the identical packet with telemetry and no second Cline run", async () => {
  const { root, workspace, stateDir, state, task } = await setup();
  let clineRuns = 0;
  const reviews = [];
  let waitingReached;
  const waiting = new Promise(resolve => { waitingReached = resolve; });
  const loop = runNodeLoop({
    workspace, stateDir, objective: "bounded", initialTask: task, maxAttempts: 2, codex: { activeCount: 0 }, pollMs: 10,
    baseline: async () => ({ head: git(workspace, "rev-parse", "HEAD") }), verify: async () => {},
    readControl: () => state.readControl(), onEvent: async (event) => {
      await state.record(event);
      if (event.type === "waiting-for-codex") waitingReached();
    }, onTask: async () => {},
    worker: { withExclusive: async (fn) => fn(), run: async (_prompt, hooks) => {
      clineRuns++; await hooks.onStart({ pid: 9876 }); await writeFile(path.join(workspace, "result.txt"), "after\n");
      return { exitCode: 0, runResult: { finishReason: "completed", text: "Changed result" }, output: "large transcript" };
    } },
    review: async (packet) => {
      reviews.push(structuredClone(packet));
      if (reviews.length === 1) throw new CodexUsageLimitError({ message: "usage limit", retryAt: "try again later" });
      return { status: "pass", output: "accepted", commit: "fake" };
    },
    assess: async () => ({ status: "done" }),
  });
  try {
    await Promise.race([
      waiting,
      loop.then((result) => { throw new Error("Loop ended before usage-limit wait: " + JSON.stringify(result)); }),
    ]);
    assert.equal((await state.readLive()).stage, "WAITING_FOR_LIMIT");
    const pending = await readPendingCodex(stateDir);
    assert.deepEqual(pending.inputs, reviews[0]);
    assert.deepEqual(pending.inputs, JSON.parse(await readFile(path.join(stateDir, "qa-packet.json"), "utf8")));
    assert.equal(clineRuns, 1);
    await state.setControl("resume");
    assert.equal((await loop).status, "done");
    assert.equal(clineRuns, 1);
    assert.deepEqual(reviews[1], reviews[0]);
    const events = await state.readEvents(100);
    const start = events.find((event) => event.type === "codex-qa-started");
    const finish = events.find((event) => event.type === "codex-qa-finished");
    assert.equal(start.changedFileCount, 1);
    assert.ok(start.diffByteCount > 0);
    assert.deepEqual(start.commands, [task.qaCommand]);
    assert.ok(Number.isFinite(finish.durationMs));
    const live = await state.readLive();
    assert.equal(live.cline.startedAt !== null, true);
    assert.equal(live.cline.durationMs !== null, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("packet-based FAIL sends one correction to Cline and PASS retains ownership", async () => {
  const { root, workspace, stateDir, state, task } = await setup();
  const prompts = [];
  let reviews = 0;
  try {
    const result = await runNodeLoop({
      workspace, stateDir, objective: "bounded", initialTask: task, maxAttempts: 2, codex: { activeCount: 0 },
      baseline: async () => ({ head: git(workspace, "rev-parse", "HEAD") }), verify: async () => {},
      readControl: () => state.readControl(), onEvent: (event) => state.record(event), onTask: async () => {},
      worker: { withExclusive: async (fn) => fn(), run: async (prompt) => { prompts.push(prompt); await writeFile(path.join(workspace, "result.txt"), prompts.length === 1 ? "broken\n" : "fixed\n"); return { exitCode: 0, runResult: { finishReason: "completed", text: "done" }, output: "ignored" }; } },
      review: async (packet) => ++reviews === 1
        ? { status: "fail", output: "actual defect", correction: "Correct result.txt only" }
        : { status: "pass", output: "accepted", commit: "fake" },
      assessCorrection: async()=>({...((await import('../fixtures/recovery-harness.mjs')).correction()),nextWorkerInstructions:'Correct result.txt only'}),
      assess: async () => ({ status: "done" }), pollMs: 5,
    });
    assert.equal(result.status, "done");
    assert.equal(prompts.length, 2);
    assert.match(prompts[1], /Correct result\.txt only/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
