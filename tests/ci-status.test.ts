import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CiCheck, Project } from "@shared/types";
import { CI_REGISTER_MS, parseRuns, readCi, summarize, type Runner } from "../src/main/lib/ci-status";
import { buildEngineArgs } from "../src/main/lib/engine-args";
import { DEFAULT_CLIS, DEFAULT_SETTINGS, defaultAgents } from "../src/main/defaults";

const SHA = "a".repeat(40);
const ghRun = (over: Record<string, unknown>) => ({ databaseId: 1, name: "test", workflowName: "CI", status: "completed", conclusion: "success", url: "https://github.com/o/r/actions/runs/1", headSha: SHA, ...over });
const check = (bucket: CiCheck["bucket"], id = 1): CiCheck => ({ id, name: "n", workflow: "CI", bucket, url: null });
const fake = (code: number, stdout: string, stderr = ""): { runner: Runner; calls: string[][] } => {
  const calls: string[][] = [];
  return { calls, runner: async (_cmd, args) => { calls.push(args); return { code, stdout, stderr }; } };
};
const opts = { gh: "gh", repo: "o/r", branch: "agent-dock/run-1", sha: SHA, cwd: ".", pushedAt: new Date(0).toISOString(), now: CI_REGISTER_MS * 10 };

describe("GitHub CI status", () => {
  it("reads only the pushed commit's runs and maps their states", () => {
    const out = JSON.stringify([
      ghRun({}), ghRun({ databaseId: 2, status: "in_progress", conclusion: "" }), ghRun({ databaseId: 3, conclusion: "timed_out" }),
      ghRun({ databaseId: 4, conclusion: "skipped" }), ghRun({ databaseId: 5, conclusion: "cancelled" }), ghRun({ databaseId: 6, headSha: "b".repeat(40), conclusion: "failure" }),
      ghRun({ databaseId: 7, url: "javascript:alert(1)", event: "pull_request" }), ghRun({ databaseId: 8, event: "push; rm" }),
    ]);
    const checks = parseRuns(out, SHA);
    expect(checks.map((c) => [c.id, c.bucket])).toEqual([[1, "pass"], [2, "pending"], [3, "fail"], [4, "skipping"], [5, "cancel"], [7, "pass"], [8, "pass"]]);
    expect(checks.at(-2)?.url).toBeNull();
    // What started each run (shown next to it), only when it looks like a GitHub event name.
    expect(checks.slice(-2).map((c) => c.event)).toEqual(["pull_request", null]);
    expect(() => parseRuns("not json", SHA)).toThrow(/could not read/);
  });

  it("sums the runs up: a failure wins, then anything still running", () => {
    expect(summarize([check("pass"), check("fail"), check("pending")])).toBe("fail");
    expect(summarize([check("pass"), check("pending")])).toBe("pending");
    expect(summarize([check("pass"), check("skipping"), check("cancel")])).toBe("pass");
    expect(summarize([check("cancel"), check("skipping")])).toBe("cancelled");
    expect(summarize([])).toBe("none");
  });

  it("says why it cannot read CI, and treats a fresh push without runs as pending", async () => {
    expect((await readCi({ ...opts, gh: null })).message).toMatch(/Install GitHub CLI/);
    expect((await readCi({ ...opts, runner: fake(4, "", "To get started with GitHub CLI, please run:  gh auth login").runner })).message).toMatch(/not signed in/);
    const { runner, calls } = fake(0, JSON.stringify([ghRun({ status: "queued", conclusion: "" })]));
    expect((await readCi({ ...opts, runner })).state).toBe("pending");
    expect(calls[0]).toEqual(["run", "list", "--repo", "o/r", "--branch", "agent-dock/run-1", "--limit", "30", "--json", "databaseId,name,workflowName,status,conclusion,url,headSha,event"]);
    expect((await readCi({ ...opts, now: 1000, runner: fake(0, "[]").runner })).state).toBe("pending");
    expect((await readCi({ ...opts, runner: fake(0, "[]").runner })).state).toBe("none");
  });

  it("never fixes or pushes by itself: the objective is only the project's", () => {
    const project: Project = { id: "p1", name: "orbit", path: "E:\\dev\\orbit", repoUrl: null, objective: "Ship it", description: "", createdAt: "", archived: false, stateDir: "C:\\state\\p1", roleOverrides: {}, workflowOverrides: {} };
    // A note an earlier version saved for a CI fix run is ignored.
    const old = { ...project, ciNote: "First fix the failed GitHub CI run" } as Project;
    const agents = defaultAgents({ qa: "gpt-6.1-sol", assessment: "gpt-6.1-sol", elevate: "gpt-6-astra", reasoning: "medium" }).map((a) => (a.role === "implementation" ? { ...a, model: "m" } : a));
    const args = (p: Project) => { const a = buildEngineArgs({ project: p, agents, clis: structuredClone(DEFAULT_CLIS), settings: structuredClone(DEFAULT_SETTINGS) }).args; return a[a.indexOf("--objective") + 1]; };
    expect(args(old)).toBe("Ship it");
  });
});
