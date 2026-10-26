import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseImplementationPlan } from "../src/main/lib/plan";
import { buildTaskBoard, keyPlanItems, planItemKey, sanitizeTaskBoardUpdate, writeTaskBoard } from "../src/main/lib/task-board";
import { boardOrder, columnItems, deriveBoard, plannedView, reorderWithin, withOrder } from "../src/shared/task-board";

const PLAN = `## Phase 1 — Base
- [x] Set up project
- [ ] Add login form
- [ ] Add logout
## Phase 2 — More
- [ ] Add tests
- [ ] Write docs
- [ ] Write docs
`;
const plan = () => parseImplementationPlan(PLAN);
const items = () => keyPlanItems(plan());
const titlesOf = (list: { title: string }[]) => list.map((i) => i.title);

describe("task board keys", () => {
  it("match the engine's keys and ignore the checkbox", () => {
    // engine/src/task-priority.mjs planItemKey(2, "  Add  Login form ", 1)
    expect(planItemKey(2, "  Add  Login form ", 1)).toBe("4ef23fe0def7");
    const open = keyPlanItems(parseImplementationPlan(PLAN.replace("- [x] Set up project", "- [ ] Set up project")));
    expect(open[0].id).toBe(items()[0].id);
  });
  it("give duplicates their own keys and flag them", () => {
    const docs = items().filter((i) => i.title === "Write docs");
    expect(docs.map((i) => i.ordinal)).toEqual([0, 1]);
    expect(docs[0].id).not.toBe(docs[1].id);
    expect(docs.every((i) => i.ambiguous)).toBe(true);
  });
});

describe("column derivation", () => {
  it("puts checked items in Finished, worked-on items in In progress and the rest in Planned", () => {
    const list = items();
    const board = deriveBoard({
      items: list,
      order: [list[4].id, list[3].id],
      revision: 3,
      groupByPhase: false,
      current: { id: "T7", name: "Login", planItems: ["Add login form"] },
      parallel: [{ id: "T8", name: "Tests", planItemIds: [list[3].id], lane: "T8-abc" }],
      deferred: [{ id: "T2", name: "Logout", reason: "stuck", planItems: ["Add logout"] }],
    });
    expect(titlesOf(columnItems(board, "finished"))).toEqual(["Set up project"]);
    // Items the saved order does not list follow their plan neighbour (the first open one goes first).
    expect(titlesOf(columnItems(board, "in-progress"))).toEqual(["Add login form", "Add tests"]);
    expect(titlesOf(columnItems(board, "planned"))).toEqual(["Add logout", "Write docs", "Write docs"]);
    const byTitle = (t: string) => board.items.find((i) => i.title === t)!;
    expect(byTitle("Add login form").activity).toEqual([{ kind: "current", taskId: "T7", name: "Login" }]);
    expect(byTitle("Add tests").activity).toEqual([{ kind: "parallel", taskId: "T8", name: "Tests", detail: "T8-abc" }]);
    expect(byTitle("Add logout").activity[0]).toMatchObject({ kind: "deferred", taskId: "T2", detail: "stuck" });
    expect(byTitle("Set up project").priority).toBeNull();
    expect(board.items.filter((i) => i.priority !== null).map((i) => i.priority)).toEqual([0, 1, 2, 3, 4]);
  });
  it("lists a task set aside by an earlier version's step-down as deferred and ignores finished items a task names", () => {
    const old = { id: "T5", name: "Whole item", planItems: ["Add logout"], stepDown: { from: "standard", to: "eco" } };
    const board = deriveBoard({ items: items(), order: [], revision: 0, groupByPhase: true, current: { id: "T1", planItems: ["Set up project"] }, deferred: [old] });
    expect(columnItems(board, "in-progress")).toEqual([]);
    expect(board.items.find((i) => i.title === "Add logout")!.activity).toEqual([{ kind: "deferred", taskId: "T5", name: "Whole item" }]);
    expect(columnItems(board, "finished")[0].activity).toEqual([]);
  });
});

describe("reordering", () => {
  const board = deriveBoard({ items: items(), order: [], revision: 0, groupByPhase: true });
  const order = boardOrder(board);
  it("moves within a phase without touching other phases' places", () => {
    const phase2 = plannedView(board, 2);
    const next = reorderWithin(order, phase2, 2, 0);
    expect(next.slice(0, 2)).toEqual(order.slice(0, 2));
    expect(next.slice(2)).toEqual([phase2[2], phase2[0], phase2[1]]);
  });
  it("moves globally in the flat list, and withOrder shows the result", () => {
    const flat = plannedView(board, null);
    const next = reorderWithin(order, flat, 3, 0);
    expect(next[0]).toBe(flat[3]);
    expect(withOrder(board, next).items[0].id).toBe(flat[3]);
    expect(reorderWithin(order, flat, 0, 0)).toBe(order);
  });
});

describe("task board IPC writes", () => {
  const state = () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "task-board-"));
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  it("saves an order on the current revision and rejects a stale one", async () => {
    const dir = state();
    const p = plan();
    const open = boardOrder(await buildTaskBoard(dir, p, null, false));
    const reversed = [...open].reverse();
    const first = await writeTaskBoard(dir, p, { expectedRevision: 0, order: reversed }, { now: () => "t1" });
    expect(first.ok).toBe(true);
    expect(first.board.revision).toBe(1);
    expect(boardOrder(first.board)).toEqual(reversed);
    const saved = JSON.parse(readFileSync(path.join(dir, "task-board.json"), "utf8"));
    expect(saved).toEqual({ version: 1, revision: 1, order: reversed, groupByPhase: true, updatedAt: "t1" });
    // A drag made on revision 0 after the write above: rejected, with the current board.
    const stale = await writeTaskBoard(dir, p, { expectedRevision: 0, order: open });
    expect(stale).toMatchObject({ ok: false, reason: "stale" });
    expect(stale.board.revision).toBe(1);
    expect(boardOrder(stale.board)).toEqual(reversed);
    // The grouping toggle is not a reorder and always applies.
    const toggled = await writeTaskBoard(dir, p, { expectedRevision: 0, groupByPhase: false });
    expect(toggled.ok && toggled.board.groupByPhase).toBe(false);
    // Reset goes back to plan order.
    const reset = await writeTaskBoard(dir, p, { expectedRevision: 2, reset: true });
    expect(reset.ok).toBe(true);
    expect(boardOrder(reset.board)).toEqual(open);
  });
  it("serializes quick writes so only one of two on the same revision lands", async () => {
    const dir = state();
    const p = plan();
    const open = boardOrder(await buildTaskBoard(dir, p, null, false));
    const [a, b] = await Promise.all([writeTaskBoard(dir, p, { expectedRevision: 0, order: [...open].reverse() }), writeTaskBoard(dir, p, { expectedRevision: 0, order: open })]);
    expect([a.ok, b.ok]).toEqual([true, false]);
  });
  it("keeps unknown and finished keys out of the saved order", async () => {
    const dir = state();
    const p = plan();
    writeFileSync(path.join(dir, "task-board.json"), JSON.stringify({ version: 1, revision: 5, order: ["000000000000", items()[0].id, items()[4].id], groupByPhase: true }));
    const r = await writeTaskBoard(dir, p, { expectedRevision: 5, order: ["000000000000", items()[0].id, items()[5].id] });
    const saved = JSON.parse(readFileSync(path.join(dir, "task-board.json"), "utf8"));
    expect(r.ok).toBe(true);
    expect(saved.order).toContain(items()[5].id);
    expect(saved.order).not.toContain(items()[0].id);
    expect(saved.order).toHaveLength(5);
  });
  it("sanitizes what arrives over IPC", () => {
    expect(() => sanitizeTaskBoardUpdate({ order: [] })).toThrow(/revision/);
    expect(sanitizeTaskBoardUpdate({ expectedRevision: 2, order: ["abcdef012345", "../x", 7], reset: "yes", groupByPhase: false, extra: 1 })).toEqual({ expectedRevision: 2, order: ["abcdef012345"], groupByPhase: false });
  });
  it("shows live parallel lanes and the unfinished current task", async () => {
    const dir = state();
    const list = items();
    mkdirSync(path.join(dir, "parallel", "T9-x"), { recursive: true });
    writeFileSync(path.join(dir, "parallel", "T9-x", "child.json"), JSON.stringify({ pid: 123, exitedAt: null }));
    writeFileSync(path.join(dir, "parallel", "T9-x", "task.json"), JSON.stringify({ id: "T9", name: "Docs", planItems: ["Add logout"] }));
    mkdirSync(path.join(dir, "parallel", "T3-old"), { recursive: true });
    writeFileSync(path.join(dir, "parallel", "T3-old", "child.json"), JSON.stringify({ pid: 99, exitedAt: "2026-01-01" }));
    writeFileSync(path.join(dir, "parallel", "T3-old", "task.json"), JSON.stringify({ id: "T3", planItems: ["Add tests"] }));
    writeFileSync(path.join(dir, "current-task.json"), JSON.stringify({ id: "T4", name: "Login", planItems: ["Add login form"], automation: { recovery: { phase: "implementing" } } }));
    const live = { task: { id: "parallel-round-2", name: "Parallel round 2" }, stage: "implementing" };
    const board = await buildTaskBoard(dir, plan(), live, true);
    expect(titlesOf(columnItems(board, "in-progress"))).toEqual(["Add login form", "Add logout"]);
    expect(board.items.find((i) => i.id === list[2].id)!.activity[0]).toMatchObject({ kind: "parallel", taskId: "T9", detail: "T9-x" });
    // Engine not running: a passed task is not in progress, and lanes are not read.
    writeFileSync(path.join(dir, "current-task.json"), JSON.stringify({ id: "T4", planItems: ["Add login form"], automation: { recovery: { phase: "passed" } } }));
    expect(columnItems(await buildTaskBoard(dir, plan(), live, false), "in-progress")).toEqual([]);
  });
});
