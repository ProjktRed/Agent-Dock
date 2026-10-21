import { describe, expect, it } from "vitest";
import type { RunReport } from "@shared/types";
import { modeEstimates, planEstimate } from "../src/renderer/src/lib/estimate";

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
  it("compares task sizes per finished plan item, leaving out runs without an item count", () => {
    const r = (taskMode: string | undefined, planItems: number | undefined, hours: number, tokens: number) => ({ taskMode, planItems, tasksApproved: 3, hours, usage: { tokens, costUsd: 0 } }) as unknown as RunReport;
    const est = modeEstimates(2, [r(undefined, 1, 2, 300), r("standard", 2, 1, 1000), r("eco", undefined, 9, 9)]);
    expect(est.eco).toMatchObject({ hours: 4, tokens: 600 });
    expect(est.standard).toMatchObject({ hours: 1, tokens: 1000 });
    expect(est.max).toBeUndefined();
    expect(modeEstimates(0, [r("eco", 1, 1, 1)])).toEqual({});
  });
});
