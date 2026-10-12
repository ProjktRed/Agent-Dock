import assert from "node:assert/strict";
import test from "node:test";
import { buildInitialPrompt, buildCorrectionPrompt } from "../src/workflow.mjs";
import { CodexWorker } from "../src/codex-worker.mjs";

const task = { id: "T", name: "Diagnose lifecycle", prompt: "Task skill: diagnose\nIdentify the owned resource", allowedPaths: ["x.js"], qaCommand: "node x.js" };

test("every Cline handoff supplies the shared skill and only the manager-selected mode", () => {
  const initial = buildInitialPrompt(task);
  assert.match(initial, /Shared skill: bounded-task-handoff/);
  assert.match(initial, /Selected task skill: diagnose/);
  assert.match(initial, /Diagnostic evidence/);
  assert.doesNotMatch(initial, /Implementation regression|Verification matrix/);
  const correction = buildCorrectionPrompt(task, "Failed evidence", 1, "Task skill: implement\nAmend x.js ownership");
  assert.match(correction, /Selected task skill: implement/);
  assert.match(correction, /Implementation regression/);
  assert.doesNotMatch(correction, /Diagnostic evidence|Verification matrix/);
  assert.match(correction, /CHANGES/);
  assert.match(correction, /TESTS/);
  assert.match(correction, /NOT RUN/);
  assert.match(correction, /node x\.js/);
});

test("legacy tasks get the shared implementation skill; invalid explicit choices fail safely", () => {
  assert.match(buildInitialPrompt({ ...task, prompt: "Fix x.js" }), /Selected task skill: implement/);
  assert.throws(() => buildInitialPrompt({ ...task, prompt: "Task skill: ../../unapproved" }), /Unknown task skill/);
  assert.throws(() => buildCorrectionPrompt(task, "failure", 1, "Task skill: invented\nFix"), /Unknown task skill/);
});

test("assessment and QA use the shared handoff skill without changing packet contents", async () => {
  const worker = Object.create(CodexWorker.prototype);
  const calls = [];
  worker.invoke = async (...args) => { calls.push(args); return { status: "done" }; };
  await worker.assess({ objective: "Diagnose a hang", previous: null });
  const packet = { task, diff: { text: "diff" }, attempt: 1, qaEvidence: {} };
  const before = structuredClone(packet);
  await worker.review(packet, { reassessment: { status: "fail", output: "strategy", correction: "collect evidence" } });
  for (const [prompt] of calls) assert.match(prompt, /Shared skill: bounded-task-handoff/);
  assert.match(calls[0][0], /Task skill: diagnose\|implement\|verify/);
  assert.match(calls[1][0], /Assessment owns corrections/);
  assert.doesNotMatch(calls[1][0], /ASTRA ADVICE/);
  assert.deepEqual(packet, before);
});

test("QA scopes developer no-commit instructions to Cline and respects approval rejection", async () => {
  const worker = Object.create(CodexWorker.prototype);
  let prompt;
  worker.invoke = async (input) => { prompt = input; return { status: "manual-review" }; };
  const packet = { task: { ...task, objective: "Cline must not commit implementation." }, qaEvidence: {}, diff: {}, attempt: 1 };
  const before = structuredClone(packet);
  await worker.review(packet);
  assert.match(prompt, /No-commit instructions in the Cline task apply to the implementing Cline worker/);
  assert.match(prompt, /If commit approval is rejected, stop and report the rejection/);
  assert.deepEqual(packet, before);
});

test("new Codex task assessments must select a known skill before handing work to Cline", async () => {
  const worker = Object.create(CodexWorker.prototype);
  worker.invoke = async () => ({ status: "task", task: { ...task, prompt: "Investigate without a skill choice" } });
  await assert.rejects(worker.assess({ objective: "Diagnose", previous: null }), /Task skill selection is required/);
  worker.invoke = async () => ({ status: "task", task });
  assert.deepEqual((await worker.assess({ objective: "Diagnose", previous: null })).task, task);
});

test("real inline assessment skill selection reaches the correct Cline handoff", async () => {
  const worker = Object.create(CodexWorker.prototype);
  const inline = { ...task, prompt: "Task skill: verify. Owner: QA-AUTO. Goal: audit manual import acceptance." };
  worker.invoke = async () => ({ status: "task", task: inline });
  const result = await worker.assess({ objective: "Audit manual import", previous: null });
  assert.deepEqual(result.task, inline);
  assert.match(buildInitialPrompt(result.task), /Selected task skill: verify/);
  assert.match(buildInitialPrompt(result.task), /Verification matrix/);
  assert.doesNotMatch(buildInitialPrompt(result.task), /Implementation regression|Diagnostic evidence/);
  for (const choice of ["verify-extra.", "invented.", "../../verify."]) {
    worker.invoke = async () => ({ status: "task", task: { ...inline, prompt: `Task skill: ${choice} Owner: QA-AUTO.` } });
    await assert.rejects(worker.assess({ objective: "Audit", previous: null }), /Unknown task skill/);
  }
});
