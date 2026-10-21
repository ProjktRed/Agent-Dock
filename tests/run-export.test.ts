import { describe, expect, it } from "vitest";
import type { RunReport } from "@shared/types";
import { runReportHtml, runReportMarkdown } from "../src/main/lib/run-export";

const report: RunReport = {
  unattended: true, startedAt: "2026-10-19T06:00:00.000Z", endedAt: "2026-10-19T07:30:00.000Z", hours: 1.5, status: "stopped",
  reason: "Spend budget reached | $2.50\nsecond line <b>", limit: "cost", tasksApproved: 2, qaFailures: 1, corrections: 1, elevations: 0, needsAttention: 0, supervisorAlerts: 0,
  approved: [{ taskId: "T1", name: "Add <slug>", at: "2026-10-19T06:40:00.000Z" }],
  usage: { tokens: 120000, input: 150000, cached: 40000, output: 10000, costUsd: 2.5, calls: 6, estimatedUsd: 2 } as RunReport["usage"],
  actionLog: { ok: true, entries: 42 },
};

describe("run report export", () => {
  it("writes Markdown with escaped table cells, approved tasks and the full reason", () => {
    const md = runReportMarkdown(report, "textkit");
    expect(md).toMatch(/^# textkit: run report/);
    expect(md).toContain("| Why it ended | Spend budget reached \\| $2.50 |");
    expect(md).toContain("| Spend | $2.50 ($2.00 estimated from the price table) |");
    expect(md).toContain("- T1: Add <slug> (2026-10-19T06:40:00.000Z)");
    expect(md).toContain("second line <b>");
    expect(md).toContain("| Action log | verified, 42 entries |");
  });
  it("writes a self-contained HTML page with everything escaped", () => {
    const html = runReportHtml(report, "text<kit>");
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain("<title>text&lt;kit&gt;: run report</title>");
    expect(html).toContain("Add &lt;slug&gt;");
    expect(html).toContain("second line &lt;b&gt;");
    expect(html).not.toMatch(/<script|<link|https?:\/\//);
  });
});
