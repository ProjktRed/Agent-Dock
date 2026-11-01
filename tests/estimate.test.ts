import { describe, expect, it } from "vitest";
import type { RunReport } from "@shared/types";
import { calibration, estimateRecord, modeEstimates, planEstimate, type EstimateRecord } from "../src/renderer/src/lib/estimate";

const run = (tasksApproved: number, hours: number, tokens: number, costUsd: number) => ({ tasksApproved, hours, usage: { tokens, costUsd } }) as unknown as RunReport;
const itemRun = (startedAt: string, planItems: number, hours: number, tokens: number, taskMode = "eco") => ({ startedAt, taskMode, planItems, tasksApproved: planItems, hours, usage: { tokens, costUsd: 0 } }) as unknown as RunReport;

describe("plan estimate", () => {
  it("scales the remaining items by this project's pace per approved task", () => {
    const est = planEstimate(4, [run(2, 1, 200_000, 2), run(0, 3, 900_000, 9), run(2, 3, 600_000, 6)], { halfLife: Infinity });
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

describe("estimate calibration", () => {
  it("counts recent runs more and shows the middle half of single runs as a range", () => {
    // Newest first: the pace went from 4 h per item down to 1 h.
    const runs = [itemRun("2026-10-04T00:00:00Z", 1, 1, 100), itemRun("2026-10-03T00:00:00Z", 1, 2, 200), itemRun("2026-10-02T00:00:00Z", 1, 3, 300), itemRun("2026-10-01T00:00:00Z", 1, 4, 400)];
    const weighted = modeEstimates(1, runs).eco!, flat = modeEstimates(1, runs, { halfLife: Infinity }).eco!;
    expect(flat.hours).toBe(2.5);
    expect(weighted.hours).toBeLessThan(2.5);
    expect(weighted.range?.hours).toEqual([1.75, 3.25]);
    expect(modeEstimates(1, runs.slice(0, 2)).eco!.range).toBeUndefined();
  });

  it("corrects a steady miss by the median of actual against estimated, within 0.5 to 2", () => {
    const records: EstimateRecord[] = [1, 2, 3].map((d) => ({ at: `2026-10-0${d}T10:00:00Z`, mode: "eco", perItem: { hours: 1, tokens: 1000, costUsd: 0 } }));
    // Each run started a minute after its estimate and took 1.5 h and 2000 tokens per item.
    const runs = [3, 2, 1].map((d) => itemRun(`2026-10-0${d}T10:01:00Z`, 2, 3, 4000));
    expect(calibration(records, runs, "eco")).toEqual({ hours: 1.5, tokens: 2, runs: 3 });
    expect(calibration(records.slice(0, 2), runs, "eco")).toBeUndefined();
    expect(calibration(records, runs, "standard")).toBeUndefined();
    const wild = [3, 2, 1].map((d) => itemRun(`2026-10-0${d}T10:01:00Z`, 1, 50, 100));
    expect(calibration(records, wild, "eco")).toEqual({ hours: 2, tokens: 0.5, runs: 3 });
    const est = modeEstimates(2, runs, { records, halfLife: Infinity }).eco!;
    expect(est).toMatchObject({ hours: 2 * 1.5 * 1.5, tokens: 2 * 2000 * 2, calibration: { hours: 1.5, tokens: 2, runs: 3 } });
  });

  it("records the uncorrected pace per item when a run starts", () => {
    const runs = [itemRun("2026-10-01T00:00:00Z", 2, 3, 500)];
    expect(estimateRecord(runs, "eco", new Date("2026-10-05T00:00:00Z"))).toEqual({ at: "2026-10-05T00:00:00.000Z", mode: "eco", perItem: { hours: 1.5, tokens: 250, costUsd: 0 } });
    expect(estimateRecord(runs, "max")).toBeNull();
  });
});
