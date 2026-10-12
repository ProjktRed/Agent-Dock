import assert from "node:assert/strict";
import test from "node:test";

import { runTask } from "../src/workflow.mjs";

const task = {
  id: "example-task",
  prompt: "Create result.txt containing exactly READY followed by a newline.",
  qaCommand: "node qa.mjs",
};

test("PASS accepts the task and requests the next Codex assessment", async () => {
  const prompts = [];
  const result = await runTask({
    task,
    worker: {
      isBusy: async () => false,
      run: async (prompt) => {
        prompts.push(prompt);
        return { exitCode: 0, output: "implemented" };
      },
    },
    runQa: async () => ({ pass: true, output: "QA PASS" }),
  });

  assert.equal(result.status, "passed");
  assert.equal(result.nextAction, "assess-next-task");
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /Create result\.txt/);
  assert.match(prompts[0], /Do not commit/);
  assert.match(prompts[0], /Do not choose the next task/);
});

test("QA failure sends a concrete correction prompt and reruns QA", async () => {
  const prompts = [];
  let qaAttempt = 0;
  const result = await runTask({
    task,
    maxAttempts: 2,
    worker: {
      isBusy: async () => false,
      run: async (prompt) => {
        prompts.push(prompt);
        return { exitCode: 0, output: "implemented" };
      },
    },
    runQa: async () => {
      qaAttempt += 1;
      return qaAttempt === 1
        ? { pass: false, output: "expected READY, received BROKEN" }
        : { pass: true, output: "QA PASS" };
    },
  });

  assert.equal(result.status, "passed");
  assert.equal(result.attempts, 2);
  assert.equal(result.history[0].qa.pass, false);
  assert.match(result.history[0].qa.output, /expected READY/);
  assert.match(result.history[1].prompt, /expected READY/);
  assert.equal(result.history[1].qa.pass, true);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /expected READY, received BROKEN/);
  assert.match(prompts[1], /node qa\.mjs/);
  assert.match(prompts[1], /Create result\.txt/);
  assert.match(prompts[1], /Do not commit/);
  assert.match(prompts[1], /Do not choose a new task/);
});

test("busy worker leaves the task queued without launching Cline", async () => {
  let runs = 0;
  const result = await runTask({
    task,
    worker: {
      isBusy: async () => true,
      run: async () => {
        runs += 1;
        return { exitCode: 0, output: "unexpected" };
      },
    },
    runQa: async () => ({ pass: true, output: "QA PASS" }),
  });

  assert.equal(result.status, "queued");
  assert.equal(runs, 0);
});

test("actionable QA failures have no numeric limit and request a revised strategy after five tries", async () => {
  let runs = 0;
  const strategyFlags = [];
  const events = [];
  const result = await runTask({
    task,
    maxAttempts: 2,
    worker: {
      isBusy: async () => false,
      run: async () => {
        runs += 1;
        return { exitCode: 0, output: "implemented" };
      },
    },
    runQa: async ({ attempt, strategyRevision }) => {
      strategyFlags.push(strategyRevision);
      return attempt < 6
        ? { pass: false, output: `still broken ${attempt}`, correction: `exact strategy ${attempt}` }
        : { pass: true, output: "QA PASS" };
    },
    onEvent: async (event) => events.push(event),
  });

  assert.equal(result.status, "passed");
  assert.equal(result.attempts, 6);
  assert.equal(runs, 6);
  assert.deepEqual(strategyFlags, [false, false, false, false, true, false]);
  assert.deepEqual(events.filter((event) => event.type === "strategy-reassessment").map((event) => event.attempt), [5]);
});

test("the worker lock remains held through QA and all retries", async () => {
  let locked = false;
  let qaAttempt = 0;
  const result = await runTask({
    task,
    worker: {
      withExclusive: async (operation) => {
        locked = true;
        try {
          return await operation();
        } finally {
          locked = false;
        }
      },
      run: async () => ({ exitCode: 0, output: "implemented" }),
    },
    prepare: async () => {
      assert.equal(locked, true);
      return { baseline: "clean" };
    },
    runQa: async () => {
      assert.equal(locked, true);
      qaAttempt += 1;
      return { pass: qaAttempt === 2, output: qaAttempt === 1 ? "fix it" : "pass" };
    },
  });

  assert.equal(result.status, "passed");
  assert.equal(locked, false);
});
