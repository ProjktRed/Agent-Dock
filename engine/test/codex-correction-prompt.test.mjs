import assert from "node:assert/strict";
import test from "node:test";

import { buildQaPrompt } from "../src/codex-worker.mjs";

const packet = {
  task: {
    id: "T-1",
    prompt: "Fix shutdown only",
    acceptanceCriteria: ["test command exits naturally"],
    qaCommand: "npm.cmd run test:e2e",
    allowedPaths: ["playwright.config.ts"],
  },
  attempt: 5,
  changedFiles: ["playwright.config.ts"],
  diff: { bytes: 120, patch: "diff" },
  qaEvidence: { command: { command: "npm.cmd run test:e2e", exitCode: 1 } },
};

test("QA remains independent at every attempt; Assessment owns correction strategy", () => {
  const prompt = buildQaPrompt(packet);
  assert.doesNotMatch(prompt, /STRATEGY REASSESSMENT REQUIRED/);
  assert.match(prompt, /Assessment owns corrections/);
  assert.match(prompt, /Leave correction empty/);
  assert.match(prompt, /manual-review/i);
});

test("ordinary QA returns actual findings rather than implementing or drafting fixes", () => {
  const prompt = buildQaPrompt({ ...packet, attempt: 2 });
  assert.doesNotMatch(prompt, /STRATEGY REASSESSMENT REQUIRED/);
  assert.match(prompt, /exact findings and remaining acceptance criteria/);
  assert.match(prompt, /Do not fix implementation, author correction tasks/);
});
