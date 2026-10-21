import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseImplementationPlan } from "../src/implementation-progress.mjs";
import { keyPlanItems, objectiveWithPriority, planItemKey, priorityText, readTaskBoardState, resolvePriority, taskPrioritySection } from "../src/task-priority.mjs";
import { CodexWorker, codexOutputSchema, parseCodexResult } from "../src/codex-worker.mjs";

const PLAN = `# Plan
## Phase 1 — Base
- [ ] Set up project
- [ ] Add login form
## Phase 2 — More
- [ ] Add tests
- [ ] Write docs
`;
const items = (text) => keyPlanItems(parseImplementationPlan(text));
const titles = (list) => list.map((i) => i.title);

test("an item's key survives checking it off and whitespace or case changes", () => {
  const before = items(PLAN);
  const after = items(PLAN.replace("- [ ] Add login form", "- [x]   add  LOGIN form"));
  assert.equal(before[1].id, after[1].id);
  assert.equal(after[1].completed, true);
  assert.equal(before[1].id, planItemKey(1, "Add login form", 0));
  // The same title in another phase is another item.
  assert.notEqual(planItemKey(1, "Add tests"), planItemKey(2, "Add tests"));
});

test("without a saved order the priority is plan order, and checked items leave it", () => {
  assert.deepEqual(titles(resolvePriority(items(PLAN), [])), ["Set up project", "Add login form", "Add tests", "Write docs"]);
  const done = items(PLAN.replace("- [ ] Set up project", "- [x] Set up project"));
  assert.deepEqual(titles(resolvePriority(done, [])), ["Add login form", "Add tests", "Write docs"]);
});

test("reconciling: removed keys drop, kept keys keep their place, new items follow their plan neighbour", () => {
  const list = items(PLAN);
  const order = ["gone-key-123", list[3].id, list[0].id, list[2].id, list[1].id];
  assert.deepEqual(titles(resolvePriority(list, order)), ["Write docs", "Set up project", "Add tests", "Add login form"]);
  const added = items(PLAN.replace("- [ ] Add tests\n", "- [ ] Add tests\n- [ ] Add e2e tests\n").replace("## Phase 1 — Base\n", "## Phase 1 — Base\n- [ ] Pick a name\n"));
  assert.deepEqual(titles(resolvePriority(added, order)), ["Pick a name", "Write docs", "Set up project", "Add tests", "Add e2e tests", "Add login form"]);
});

test("duplicate titles get their own keys and are flagged ambiguous", () => {
  const list = items("## Phase 1 — A\n- [ ] Fix bug\n- [ ] Fix bug\n## Phase 2 — B\n- [ ] Fix bug\n- [ ] Unique\n");
  assert.equal(new Set(list.map((i) => i.id)).size, 4);
  assert.deepEqual(list.map((i) => i.ordinal), [0, 1, 0, 0]);
  assert.deepEqual(list.map((i) => i.ambiguous), [true, true, true, false]);
  assert.match(priorityText(resolvePriority(list, [])), /Fix bug \(phase 1; title appears more than once in the plan\)/);
});

test("the task board file is read defensively", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "task-board-"));
  assert.deepEqual((await readTaskBoardState(dir)).order, []);
  await writeFile(path.join(dir, "task-board.json"), "{not json");
  assert.equal((await readTaskBoardState(dir)).revision, 0);
  await writeFile(path.join(dir, "task-board.json"), JSON.stringify({ version: 1, revision: 4, order: ["a", 3, "b"], groupByPhase: false, updatedAt: "x" }));
  assert.deepEqual(await readTaskBoardState(dir), { version: 1, revision: 4, order: ["a", "b"], groupByPhase: false, updatedAt: "x" });
});

test("the priority order, with deferred items marked, reaches the Assessment prompt", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "task-priority-ws-"));
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "task-priority-state-"));
  await writeFile(path.join(workspace, "IMPLEMENTATION_PLAN.md"), PLAN);
  const list = items(PLAN);
  await writeFile(path.join(stateDir, "task-board.json"), JSON.stringify({ version: 1, revision: 2, order: [list[2].id, list[0].id], groupByPhase: true, updatedAt: null }));
  await writeFile(path.join(stateDir, "deferred-tasks.json"), JSON.stringify([{ id: "T9", name: "Login", reason: "stuck", stash: null, planItems: ["Add login form"] }]));
  const section = await taskPrioritySection({ workspace, stateDir });
  assert.match(section, /^Task priority/);
  assert.match(section, /highest-priority eligible item/);
  // Items the saved order does not list follow their plan neighbour.
  const lines = section.split("\n").filter((l) => /^\d+\. /.test(l));
  assert.deepEqual(lines, [
    `1. [${list[2].id}] Add tests (phase 2)`,
    `2. [${list[3].id}] Write docs (phase 2)`,
    `3. [${list[0].id}] Set up project (phase 1)`,
    `4. [${list[1].id}] Add login form (phase 1; deferred)`,
  ]);
  const objective = await objectiveWithPriority({ workspace, stateDir, objective: "Build it" });
  assert.ok(objective.startsWith("Build it\n\nTask priority"));

  // CodexWorker.assessOnce puts the objective, with the section, into the Assessment prompt.
  const worker = Object.create(CodexWorker.prototype);
  let prompt = "";
  worker.invoke = async (text) => { prompt = text; return { status: "done", task: null, output: "", correction: "", commit: "", manualReviewCause: null }; };
  worker.optionsForRole = () => ({});
  await worker.assessOnce({ objective, previous: null });
  assert.ok(prompt.includes(`1. [${list[2].id}] Add tests (phase 2)`));
  assert.match(prompt, /planItemIds:/);

  // No plan: the objective is unchanged.
  const empty = await mkdtemp(path.join(os.tmpdir(), "task-priority-none-"));
  assert.equal(await objectiveWithPriority({ workspace: empty, stateDir, objective: "Build it" }), "Build it");
});

test("planItemIds is part of the strict task schema and optional in older results", () => {
  const task = codexOutputSchema.properties.task.anyOf[0];
  assert.ok(task.required.includes("planItemIds"));
  const base = { id: "T1", name: "n", prompt: "p", qaCommand: "npm test", allowedPaths: ["src/a.ts"], planItems: ["Add tests"] };
  const wrap = (t) => JSON.stringify({ status: "task", task: t, output: "", correction: "", commit: "", manualReviewCause: null });
  assert.deepEqual(parseCodexResult(wrap(base)).task.planItemIds, []);
  assert.deepEqual(parseCodexResult(wrap({ ...base, planItemIds: ["abc"] })).task.planItemIds, ["abc"]);
  assert.throws(() => parseCodexResult(wrap({ ...base, planItemIds: [1] })), /planItemIds/);
});
