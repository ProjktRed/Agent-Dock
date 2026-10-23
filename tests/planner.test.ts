import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CliConnection } from "@shared/types";
import { buildPlannerPrompt, cleanPlanText, generatePlan, pickPlannerFiles, planProblem, savePlan, workspaceSummary } from "../src/main/planner";

const GOOD = "# Implementation plan\n\n## Phase 1 — Setup\n- [ ] Add a package.json with a test script\n- [ ] Add src/index.js exporting add()\n\n## Phase 2 — Tests\n- [ ] Cover add() with node:test\n";
const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
const tmp = async () => { const d = await mkdtemp(path.join(os.tmpdir(), "planner-")); dirs.push(d); return d; };
const local = (location = "http://127.0.0.1:8081/v1", kind: CliConnection["kind"] = "llamacpp") => ({ id: "l", kind, name: "Local", location } as CliConnection);

function fakeModel(...answers: string[]) {
  const requests: { url: string; body: any; auth?: string }[] = [];
  const fetchImpl = async (url: string, init: { headers: Record<string, string>; body: string }) => {
    requests.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization });
    const content = answers.shift() ?? "";
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }), text: async () => content };
  };
  return { fetchImpl, requests };
}

describe("planner", () => {
  it("asks for exactly the plan structure the engine reads", () => {
    const prompt = buildPlannerPrompt("Build a calculator", null);
    expect(prompt).toContain("Build a calculator");
    expect(prompt).toMatch(/## Phase 1 — <title>[\s\S]*- \[ \] <task>/);
    expect(prompt).toMatch(/Do not edit, create or delete/);
    expect(buildPlannerPrompt("x", "Files (1):\na.js")).toContain("Workspace summary:\nFiles (1):\na.js");
  });

  it("cleans fences and chatter and checks the structure", () => {
    expect(cleanPlanText("Sure! Here it is:\n```markdown\n" + GOOD + "```\nGood luck")).toBe(GOOD);
    expect(cleanPlanText("## Phase 1 — A\n- [ ] t\n")).toMatch(/^# Implementation plan\n\n## Phase 1/);
    expect(planProblem(GOOD)).toBeNull();
    expect(planProblem("# Implementation plan\nJust prose")).toMatch(/Phase N/);
    expect(planProblem("## Phase 1 — A\n## Phase 2 — B\n- [ ] t")).toMatch(/Phase 1 has no/);
  });

  it("gives a local model the workspace summary and retries once when the answer has no phases", async () => {
    const ws = await tmp();
    await writeFile(path.join(ws, "README.md"), "Calculator project");
    const { fetchImpl, requests } = fakeModel("I think you should build it.", GOOD);
    const plan = await generatePlan(ws, "Build a calculator", { connection: local("http://127.0.0.1:11434", "ollama"), model: "glm", apiKey: null }, new AbortController().signal, fetchImpl as never);
    expect(plan).toBe(GOOD);
    expect(requests[0].url).toBe("http://127.0.0.1:11434/v1/chat/completions");
    expect(requests[0].body.model).toBe("glm");
    expect(requests[0].body.messages[0].content).toContain("README.md:\nCalculator project");
    expect(requests[1].body.messages[0].content).toMatch(/previous answer could not be used/);
  });

  it("shows a local planner the start of the files that matter most for the objective", async () => {
    expect(pickPlannerFiles(["docs/guide.md", "src/deep/nested/util.ts", "src/index.ts", "src/parser.ts", "test/parser.test.ts", "node_modules/x/index.js", "package-lock.json", "src/calc/parser-helpers.ts"], "Fix the parser for negative numbers", 3))
      .toEqual(["src/index.ts", "src/parser.ts", "src/calc/parser-helpers.ts"]);
    const ws = await tmp();
    await writeFile(path.join(ws, "index.js"), "export const add = (a, b) => a + b;\n" + "// filler\n".repeat(1000));
    await writeFile(path.join(ws, "notes.txt"), "not source");
    const summary = await workspaceSummary(ws, "Add subtraction");
    expect(summary).toContain("index.js (first 2500 of");
    expect(summary).toContain("export const add");
    expect(summary).not.toContain("notes.txt:\n");
  });

  it("fails clearly when the second answer is still unusable, and needs an objective and a local model", async () => {
    const ws = await tmp();
    const run = { connection: local(), model: "m", apiKey: "k" };
    const { fetchImpl, requests } = fakeModel("nope", "still nope");
    await expect(generatePlan(ws, "Goal", run, new AbortController().signal, fetchImpl as never)).rejects.toThrow(/not a usable plan/);
    expect(requests[0].auth).toBe("Bearer k");
    await expect(generatePlan(ws, "  ", run, new AbortController().signal, fetchImpl as never)).rejects.toThrow(/objective/);
    await expect(generatePlan(ws, "Goal", { ...run, model: null }, new AbortController().signal, fetchImpl as never)).rejects.toThrow(/local model/);
  });

  // Retest (0.38.1): a planner cancelled before it started still ran and returned a plan.
  it("starts nothing when planning was cancelled before it began", async () => {
    const ws = await tmp();
    const { fetchImpl, requests } = fakeModel("# Plan");
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(generatePlan(ws, "Goal", { connection: local(), model: "m", apiKey: null }, cancelled.signal, fetchImpl as never)).rejects.toThrow(/cancelled/);
    expect(requests.length).toBe(0);
  });

  it("saves the plan, commits only that file, and never overwrites an existing plan", async () => {
    const ws = await tmp();
    const git = (...args: string[]) => execFileSync("git", args, { cwd: ws, encoding: "utf8" });
    git("init", "-b", "main"); git("config", "user.email", "t@example.com"); git("config", "user.name", "T");
    await writeFile(path.join(ws, "a.txt"), "a"); git("add", "-A"); git("commit", "-m", "init");
    await writeFile(path.join(ws, "unrelated.txt"), "keep me uncommitted");
    expect(await savePlan(ws, GOOD)).toEqual({ committed: true });
    expect(git("show", "--name-only", "--format=%s", "HEAD").trim().split(/\r?\n/)).toEqual(["Add implementation plan", "", "IMPLEMENTATION_PLAN.md"]);
    expect(git("status", "--porcelain")).toContain("?? unrelated.txt");
    expect(await readFile(path.join(ws, "IMPLEMENTATION_PLAN.md"), "utf8")).toBe(GOOD);
    await expect(savePlan(ws, GOOD)).rejects.toThrow(/already exists/);
    await expect(savePlan(await tmp(), "no phases here")).rejects.toThrow(/Phase N/);
  });
});
