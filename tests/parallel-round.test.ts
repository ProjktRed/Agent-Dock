import { describe, expect, it } from "vitest";
import type { ParallelRound, ParallelTaskStage, TaskBoard, TaskBoardColumn } from "@shared/types";
import { parallelCycleKeys, parallelRoundSummary, planItemActive } from "../src/renderer/src/lib/parallel-round";

const round = (n: number, stages: ParallelTaskStage[]): ParallelRound => ({
  round: n,
  startedAt: null,
  tasks: stages.map((stage, i) => ({ id: `t${i}`, name: `Task ${i}`, stage, attempt: 1, branch: null, startedAt: null })),
});

const board = (items: { title: string; phase: number; column: TaskBoardColumn }[]): TaskBoard => ({
  revision: 1,
  groupByPhase: true,
  items: items.map((i, n) => ({ id: `k${n}`, phase: { number: i.phase, title: `Phase ${i.phase}` }, title: i.title, depth: 0, column: i.column, priority: null, ambiguous: false, activity: [] })),
});

describe("Overview › Progress during a parallel round", () => {
  it("summarizes the round for the cycle strip, stages in cycle order", () => {
    expect(parallelRoundSummary(round(1, ["qa", "implementation"]))).toBe("Parallel round 1 · 2 tasks: Implementation 1, QA 1");
    expect(parallelRoundSummary(round(3, ["implementation", "implementation", "merged"]))).toBe("Parallel round 3 · 3 tasks: Implementation 2, Done 1");
    expect(parallelRoundSummary(round(2, ["starting"]))).toBe("Parallel round 2 · 1 task: Starting 1");
    expect(parallelRoundSummary(round(4, []))).toBe("Parallel round 4 · 0 tasks");
  });

  it("marks the cycle boxes the round's tasks are in", () => {
    expect([...parallelCycleKeys(round(1, ["implementation", "qa", "implementation"]))].sort()).toEqual(["implementation", "qa"]);
    expect([...parallelCycleKeys(round(1, ["starting", "merged", "waiting-limit"]))]).toEqual([]);
    expect(parallelCycleKeys(undefined).size).toBe(0);
  });
});

describe("Implementation plan card › items in progress", () => {
  const b = board([
    { title: "maxOf(numbers) in src/maxOf.js", phase: 3, column: "in-progress" },
    { title: "range(a, b) in  src/range.js", phase: 3, column: "in-progress" },
    { title: "isEven(n) in src/isEven.js", phase: 3, column: "planned" },
    { title: "sum in src/sum.js", phase: 1, column: "finished" },
  ]);

  it("marks every open item the Task board has in progress, matched by phase and title", () => {
    expect(planItemActive({ title: "maxOf(numbers) in src/maxOf.js", completed: false }, 3, b, null)).toBe(true);
    expect(planItemActive({ title: "Range(a, b) in src/range.js", completed: false }, 3, b, null)).toBe(true);
    expect(planItemActive({ title: "isEven(n) in src/isEven.js", completed: false }, 3, b, "isEven")).toBe(false);
    expect(planItemActive({ title: "maxOf(numbers) in src/maxOf.js", completed: false }, 2, b, null)).toBe(false);
    expect(planItemActive({ title: "maxOf(numbers) in src/maxOf.js", completed: true }, 3, b, null)).toBe(false);
  });

  it("falls back to the current task's name without a board", () => {
    expect(planItemActive({ title: "isEven(n) in src/isEven.js", completed: false }, 3, undefined, "isEven(n)")).toBe(true);
    expect(planItemActive({ title: "isEven(n) in src/isEven.js", completed: false }, 3, undefined, "square")).toBe(false);
    expect(planItemActive({ title: "isEven(n) in src/isEven.js", completed: false }, 3, undefined, null)).toBe(false);
  });
});
