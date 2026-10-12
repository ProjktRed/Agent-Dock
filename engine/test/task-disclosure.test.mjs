import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createTaskDisclosure } from "../ui/task-disclosure.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Current Task is collapsed by default and toggles without mutating task data", () => {
  const task = { id: "T-1", name: "Compact title", prompt: "Full objective", acceptanceCriteria: ["A"] };
  const original = structuredClone(task);
  const disclosure = createTaskDisclosure();
  assert.equal(disclosure.expanded, false);
  assert.deepEqual(task, original);
  disclosure.expand();
  assert.equal(disclosure.expanded, true);
  disclosure.collapse();
  assert.equal(disclosure.expanded, false);
  assert.deepEqual(task, original);
});

test("normal polling does not reset the user task disclosure choice", () => {
  const disclosure = createTaskDisclosure();
  disclosure.expand();
  for (let poll = 0; poll < 5; poll++) disclosure.onPoll({ task: { id: "T-1" } });
  assert.equal(disclosure.expanded, true);
  disclosure.collapse();
  disclosure.onPoll({ task: { id: "T-1", prompt: "updated display data" } });
  assert.equal(disclosure.expanded, false);
});

test("dashboard markup keeps compact summary visible and full task content in expandable region", async () => {
  const html = await readFile(path.join(root, "ui", "index.html"), "utf8");
  assert.match(html, /id="task-card"[^>]*collapsed/);
  for (const id of ["task-id", "task-name", "task-state", "attempt", "toggle-task-card"]) assert.match(html, new RegExp(`id="${id}"`));
  for (const id of ["task-description", "task-acceptance", "baseline-sha", "current-sha", "task-started", "toggle-details"]) {
    assert.match(html, new RegExp(`class="[^"]*task-expanded-content[^"]*"[\\s\\S]*id="${id}"|id="${id}"[\\s\\S]*class="[^"]*task-expanded-content`, "m"));
  }
});
