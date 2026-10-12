import assert from "node:assert/strict";
import test from "node:test";
import { CodexWorker } from "../src/codex-worker.mjs";

test("Codex QA receives the compact packet and a narrow evidence-first prompt", async () => {
  const packet = {
    task: { id: "T", objective: "bounded", allowedPaths: ["a.js"] }, acceptanceCriteria: ["works"],
    baselineSha: "abc", diff: { text: "patch", bytes: 5, truncated: false }, changedFiles: ["a.js"],
    clineSummary: { exitCode: 0, finishReason: "completed", text: "done" }, attempt: 1,
    qaEvidence: { command: { command: "npm.cmd test", exitCode: 0, durationMs: 1, summary: "ok", truncated: false }, categories: { tests: "PASS", typecheck: "NOT RUN", lint: "NOT RUN", build: "NOT RUN", scopeCheck: "PASS" } },
  };
  const worker = Object.create(CodexWorker.prototype);
  let received;
  worker.invoke = async (prompt, sandbox, options) => { received = { prompt, sandbox, options }; return { status: "pass" }; };
  await worker.review(packet);
  assert.equal(received.sandbox, "workspace-write");
  assert.equal(received.options.model, 'gpt-6.1-sol');assert.equal(received.options.reasoningEffort,'medium');assert.ok(received.options.schema.properties.verifiedIssue);
  assert.match(received.prompt, /Use the QA packet first/);
  assert.match(received.prompt, /missing, conflicting, or inconclusive/);
  assert.doesNotMatch(received.prompt, /Review the entire diff|Run the task qaCommand independently|process.tree|Get-Process/i);
  const input = JSON.parse(received.prompt.slice(received.prompt.lastIndexOf("\nINPUT: ") + 8));
  assert.deepEqual(input, packet);
});

test("Codex assessment requires a task whose allowed paths can satisfy its QA command", async () => {
  const worker = Object.create(CodexWorker.prototype);
  let received;
  let options;
  worker.invoke = async (prompt, _sandbox, modelOptions) => {
    received = prompt;
    options = modelOptions;
    return { status: "done" };
  };

  await worker.assess({ objective: "Continue Phase 1", previous: null });

  assert.deepEqual(options, { model: "gpt-6.1-sol", reasoningEffort: "medium" });

  assert.match(received, /allowedPaths.*sufficient.*qaCommand/i);
  assert.match(received, /validation.*requires changes outside.*allowedPaths.*manual-review/i);
  assert.match(received, /Do not weaken tests.*type assertions.*any/i);
});
