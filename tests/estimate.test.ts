import { describe, expect, it } from "vitest";
import type { RunReport } from "@shared/types";
import { planEstimate } from "../src/renderer/src/lib/estimate";

const run = (tasksApproved: number, hours: number, tokens: number, costUsd: number) => ({ tasksApproved, hours, usage: { tokens, costUsd } }) as unknown as RunReport;

describe("plan estimate", () => {
  it("scales the remaining items by this project's pace per approved task", () => {
    const est = planEstimate(4, [run(2, 1, 200_000, 2), run(0, 3, 900_000, 9), run(2, 3, 600_000, 6)]);
    expect(est).toEqual({ tasks: 4, hours: 4, tokens: 800_000, costUsd: 8, basisTasks: 4 });
  });
  it("gives nothing without history or remaining work", () => {
    expect(planEstimate(3, [])).toBeNull();
    expect(planEstimate(3, [run(0, 2, 1, 1)])).toBeNull();
    expect(planEstimate(0, [run(2, 1, 1, 1)])).toBeNull();
  });
});
