import { describe, expect, it } from "vitest";
import type { Agent, CliConnection, Project, Settings } from "@shared/types";
import { parseImplementationPlan } from "../src/main/lib/plan";
import { buildStatus, cycleStage, deriveRunState } from "../src/main/lib/status";
import { agentForRole, buildEngineArgs } from "../src/main/lib/engine-args";
import { classifyPrompt, countCompactions, implementationUsage, parseInvocationUsage } from "../src/main/lib/usage";
import { parsePorcelain } from "../src/main/lib/git";
import { firstVersion, pickRunnable } from "../src/main/lib/clis";
import { parseSkillFile } from "../src/main/skills";
import { taskHistory } from "../src/main/projects";
import { DEFAULT_CLIS, DEFAULT_SETTINGS, defaultAgents } from "../src/main/defaults";

const project = (over: Partial<Project> = {}): Project => ({
  id: "p1",
  name: "orbit",
  path: "E:\\dev\\orbit",
  repoUrl: null,
  objective: "Ship the rate limiter",
  description: "",
  createdAt: "",
  archived: false,
  stateDir: "C:\\state\\p1",
  roleOverrides: {},
  workflowOverrides: {},
  ...over,
});
const agents = (): Agent[] => defaultAgents({ qa: "gpt-6.1-sol", assessment: "gpt-6.1-sol", elevate: "gpt-6-astra", reasoning: "medium" });
const settings = (): Settings => structuredClone(DEFAULT_SETTINGS);
const clis = (): CliConnection[] => structuredClone(DEFAULT_CLIS);

describe("implementation plan", () => {
  it("parses phases, nested tasks and the current phase like the engine", () => {
    const plan = parseImplementationPlan(
      "# Plan\n## Phase 1 — Setup\n- [x] a\n- [x] b\n## Phase 2: Core\n- [x] c\n- [ ] d\n  - [ ] d.1\n## Notes\n- [ ] ignored\n",
    );
    expect(plan.phases.map((p) => [p.number, p.title, p.completed, p.total])).toEqual([
      [1, "Setup", 2, 2],
      [2, "Core", 1, 3],
    ]);
    expect(plan.phases[1].tasks[2]).toEqual({ title: "d.1", completed: false, depth: 1 });
    expect(plan.currentPhase).toBe(2);
    expect(plan.percent).toBe(60);
  });
  it("prefers the phase named by the active task id", () => {
    expect(parseImplementationPlan("## Phase 1\n- [ ] a\n## Phase 3\n- [ ] b\n", { id: "P3-002" }).currentPhase).toBe(3);
  });
});

describe("run state", () => {
  it("never reports running when the engine process is gone", () => {
    expect(deriveRunState({ stage: "cline-working", clineStatus: "running" }, {}, false).runState).toBe("idle");
    expect(deriveRunState({ stage: "cline-working", clineStatus: "running" }, {}, true)).toEqual({ runState: "running", label: "Running · Implementation" });
  });
  it("maps engine stages to attention, blocked, limit and control states", () => {
    expect(deriveRunState({ stage: "USER_ATTENTION" }, {}, true).runState).toBe("attention");
    expect(deriveRunState({ stage: "BLOCKED" }, {}, false).runState).toBe("blocked");
    expect(deriveRunState({ stage: "WAITING_FOR_CODEX" }, {}, true).runState).toBe("waiting-limit");
    expect(deriveRunState({ stage: "codex-qa", qaStatus: "running" }, { pauseAfterCurrent: true }, true).runState).toBe("pausing");
    expect(deriveRunState({ stage: "codex-qa" }, { stopAfterSafePoint: true }, true).runState).toBe("stopping");
    expect(deriveRunState({ stage: "paused" }, { pauseAfterCurrent: true }, true).runState).toBe("paused");
  });
  it("places the active cycle stage", () => {
    expect(cycleStage({ assessmentRunning: true })).toBe("assessment");
    expect(cycleStage({ stage: "cline-working", clineStatus: "running" })).toBe("implementation");
    expect(cycleStage({ stage: "codex-qa", qaStatus: "running" })).toBe("qa");
    expect(cycleStage({ stage: "retry" })).toBe("correction");
  });
  it("computes elapsed only while Cline runs", () => {
    const base = { projectId: "p", control: {}, processAlive: true, pid: 1, events: [], git: { isRepo: true, branch: "main", head: null, remote: null, ahead: 0, behind: 0, changedFiles: [] }, plan: parseImplementationPlan(""), elevate: { available: false, reason: null }, resolver: { available: false, reason: null } };
    const running = buildStatus({ ...base, live: { clineStatus: "running", cline: { startedAt: "2026-01-01T00:00:00.000Z" } }, now: Date.parse("2026-01-01T00:01:05.000Z") });
    expect(running.clineElapsedMs).toBe(65_000);
    const done = buildStatus({ ...base, live: { clineStatus: "idle", cline: { startedAt: "2026-01-01T00:00:00.000Z", durationMs: 1234 } } });
    expect(done.clineElapsedMs).toBe(1234);
  });
});

describe("engine launch args", () => {
  it("maps the default agents onto engine flags", () => {
    const plan = buildEngineArgs({ project: project(), agents: agents(), clis: clis(), settings: settings() });
    expect(plan.problems).toEqual([]);
    const flag = (name: string) => plan.args[plan.args.indexOf(name) + 1];
    expect(flag("--provider")).toBe("llamacpp");
    expect(flag("--model")).toBe("glm-4.7-flash-ud-q3-k-xl");
    expect(flag("--cline-context-tokens")).toBe("98304");
    expect(flag("--orchestrator")).toBe("codex");
    expect(flag("--sol-reassessment")).toBe("true");
    expect(flag("--tool-guard")).toBe("true");
    expect(plan.args).not.toContain("--codex-exe");
  });
  it("switches to the Claude orchestrator and disables elevation when its agent is off", () => {
    const list = agents().map((a) => (a.role === "qa" || a.role === "assessment" ? { ...a, cliId: "claude" } : a.role === "elevation" ? { ...a, enabled: false } : a));
    const plan = buildEngineArgs({ project: project(), agents: list, clis: clis(), settings: settings() });
    expect(plan.args[plan.args.indexOf("--orchestrator") + 1]).toBe("claude");
    expect(plan.args[plan.args.indexOf("--sol-reassessment") + 1]).toBe("false");
  });
  it("reports blocking problems instead of launching", () => {
    const list = agents().map((a) => (a.role === "assessment" ? { ...a, cliId: "claude" } : a));
    const plan = buildEngineArgs({ project: project({ objective: " " }), agents: list, clis: clis(), settings: settings() });
    expect(plan.problems.join(" ")).toMatch(/objective/);
    expect(plan.problems.join(" ")).toMatch(/same orchestrator/);
  });
  it("honours project role overrides and workflow overrides", () => {
    const list = [...agents(), { ...agents()[0], id: "local2", name: "Local 2", provider: "ollama" as const, model: "qwen3-coder:30b" }];
    const p = project({ roleOverrides: { implementation: "local2" }, workflowOverrides: { toolGuard: false } });
    expect(agentForRole("implementation", p, list)?.id).toBe("local2");
    const plan = buildEngineArgs({ project: p, agents: list, clis: clis(), settings: settings() });
    expect(plan.args[plan.args.indexOf("--provider") + 1]).toBe("ollama");
    expect(plan.args[plan.args.indexOf("--tool-guard") + 1]).toBe("false");
  });
  it("passes each orchestrator agent's model, effort and speed; Resolver follows Assessment", () => {
    const list = agents().map((a) =>
      a.role === "qa" ? { ...a, model: "gpt-6-luna", reasoning: "high", fast: true } : a.role === "assessment" ? { ...a, model: "gpt-6-sol", reasoning: "xhigh" } : a,
    );
    const plan = buildEngineArgs({ project: project(), agents: list, clis: clis(), settings: settings() });
    const flag = (name: string) => plan.args[plan.args.indexOf(name) + 1];
    expect(plan.problems).toEqual([]);
    expect([flag("--qa-model"), flag("--qa-effort"), flag("--qa-fast")]).toEqual(["gpt-6-luna", "high", "true"]);
    expect([flag("--assessment-model"), flag("--assessment-effort"), flag("--assessment-fast")]).toEqual(["gpt-6-sol", "xhigh", "false"]);
    expect([flag("--resolver-model"), flag("--resolver-effort")]).toEqual(["gpt-6-sol", "xhigh"]);
    expect(flag("--elevate-model")).toBe("gpt-6-astra");
  });
  it("rejects a model from the other CLI and an Elevation agent on another orchestrator", () => {
    const list = agents().map((a) => (a.role === "qa" ? { ...a, model: "sonnet" } : a.role === "elevation" ? { ...a, cliId: "claude" } : a));
    const plan = buildEngineArgs({ project: project(), agents: list, clis: clis(), settings: settings() });
    expect(plan.problems.some((p) => p.includes("“sonnet” is not a Codex model"))).toBe(true);
    expect(plan.problems.some((p) => p.includes("Elevation agent"))).toBe(true);
    expect(plan.args).not.toContain("--qa-model");
  });
});

describe("local providers", () => {
  it("passes thinking and the llama.cpp models folder, and rejects a model the provider did not list", () => {
    const list = agents().map((a) => (a.role === "implementation" ? { ...a, model: "GLM", reasoning: "medium" } : a));
    const withDir = clis().map((c) => (c.kind === "llamacpp" ? { ...c, modelsDir: "E:\\LLM-Models", collected: { at: "", source: "", error: null, models: [{ id: "GLM", detail: "", contextTokens: null, thinking: null }] } } : c));
    const plan = buildEngineArgs({ project: project(), agents: list, clis: withDir, settings: settings() });
    const flag = (name: string) => plan.args[plan.args.indexOf(name) + 1];
    expect(plan.problems).toEqual([]);
    expect(flag("--cline-thinking")).toBe("medium");
    expect(flag("--llamacpp-models-dir")).toBe("E:\\LLM-Models");
    const stale = buildEngineArgs({ project: project(), agents: agents(), clis: withDir, settings: settings() });
    expect(stale.problems.some((p) => p.includes("not in the list collected from"))).toBe(true);
    expect(buildEngineArgs({ project: project(), agents: agents(), clis: clis(), settings: settings() }).args).not.toContain("--llamacpp-models-dir");
  });
  it("reads llama.cpp router listings", async () => {
    const { parseLlamaModels } = await import("../src/main/local-models");
    const body = { data: [{ id: "GLM", source: "models_dir", status: { value: "unloaded" } }, { id: "glm-4.7-flash-ud-q3-k-xl" }] };
    expect(parseLlamaModels(body)).toEqual([
      { id: "GLM", detail: "unloaded · from models folder", contextTokens: null, thinking: null },
      { id: "glm-4.7-flash-ud-q3-k-xl", detail: "served model", contextTokens: null, thinking: null },
    ]);
  });
});

describe("model catalogs", () => {
  it("parses Codex model/list: hidden models dropped, efforts, default effort and the Fast tier", async () => {
    const { parseCodexModels } = await import("../src/main/lib/models-parse");
    const efforts = ["low", "medium", "high", "xhigh", "max", "ultra"].map((reasoningEffort) => ({ reasoningEffort }));
    const result = parseCodexModels({
      data: [
        { id: "gpt-6.1-sol", model: "gpt-6.1-sol", displayName: "GPT-6.1-Sol", description: "Latest workhorse model", hidden: false, supportedReasoningEfforts: efforts, defaultReasoningEffort: "low", serviceTiers: [{ id: "priority", name: "Fast", description: "2x speed, increased usage" }], isDefault: true },
        { id: "gpt-reserve", model: "gpt-reserve", hidden: true, supportedReasoningEfforts: efforts },
        { id: "gpt-6-luna", model: "gpt-6-luna", displayName: "GPT-6-Luna", hidden: false, supportedReasoningEfforts: efforts.slice(0, 5), defaultReasoningEffort: "medium", serviceTiers: [] },
      ],
    });
    expect(result.models.map((m) => m.id)).toEqual(["gpt-6.1-sol", "gpt-6-luna"]);
    expect(result.models[0]).toMatchObject({ efforts: ["low", "medium", "high", "xhigh", "max", "ultra"], defaultEffort: "low", fast: true, fastDescription: "2x speed, increased usage", isDefault: true });
    expect(result.models[1]).toMatchObject({ fast: false, efforts: ["low", "medium", "high", "xhigh", "max"] });
  });
  it("parses the Claude Code initialize models: aliases resolved, default marked, fast availability", async () => {
    const { parseClaudeModels } = await import("../src/main/lib/models-parse");
    const levels = ["low", "medium", "high", "xhigh", "max"];
    const result = parseClaudeModels({
      models: [
        { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default (recommended)", supportsEffort: true, supportedEffortLevels: levels, supportsFastMode: true },
        { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5", description: "For complex work", supportsEffort: true, supportedEffortLevels: levels, supportsFastMode: true },
        { value: "sonnet", resolvedModel: "claude-sonnet-5-5", displayName: "Sonnet 5.5", supportsEffort: true, supportedEffortLevels: levels },
        { value: "claude-haiku-4-5-20251001", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5" },
      ],
      fast_mode_disabled_reason: "extra_usage_disabled",
    });
    expect(result.models.map((m) => m.id)).toEqual(["opus", "sonnet", "claude-haiku-4-5-20251001"]);
    expect(result.models[0]).toMatchObject({ resolved: "claude-opus-5-5", isDefault: true, fast: true });
    expect(result.models[1]).toMatchObject({ isDefault: false, fast: false, efforts: levels });
    expect(result.models[2]).toMatchObject({ resolved: null, efforts: [] });
    expect(result.fastBlockedReason).toBe("Needs extra usage enabled on your Claude account");
  });
});

describe("usage telemetry", () => {
  it("reads Codex turn usage and Claude result usage without inventing values", () => {
    expect(parseInvocationUsage('{"type":"turn.completed","usage":{"input_tokens":21464,"cached_input_tokens":100,"output_tokens":837}}\n')).toEqual({ provider: "OpenAI · Codex", input: 21464, cached: 100, output: 837 });
    expect(parseInvocationUsage('{"type":"result","usage":{"input_tokens":4,"cache_creation_input_tokens":50,"cache_read_input_tokens":70,"output_tokens":30}}')).toEqual({ provider: "Anthropic · Claude Code", input: 124, cached: 70, output: 30 });
    expect(parseInvocationUsage('{"type":"turn.started"}\nnot json')).toBeNull();
  });
  it("classifies invocation roles from the engine prompt opening", () => {
    expect(classifyPrompt("You are Codex performing one bounded QA operation.")).toBe("qa");
    expect(classifyPrompt("You are QA: Claude Sonnet (medium effort)")).toBe("qa");
    expect(classifyPrompt("You are Codex performing one assessment operation.")).toBe("assessment");
    expect(classifyPrompt("You are Sol performing one short-lived, read-only reassessment")).toBe("elevation");
    expect(classifyPrompt("You are Resolver: Claude Sonnet")).toBe("resolver");
  });
  it("turns llama.cpp metric events into implementation records and counts compactions", () => {
    const events = [
      { timestamp: "t1", type: "cline-provider-metrics", requestedProvider: "llamacpp", model: "glm", promptTokens: 14073, generatedTokens: 1021, taskId: "A1" },
      { timestamp: "t2", type: "cline-message", message: "auto-compacted" },
      { timestamp: "t3", type: "cline-message", message: "hello" },
    ];
    expect(implementationUsage(events, "p")).toMatchObject([{ role: "implementation", input: 14073, output: 1021, model: "glm", taskId: "A1" }]);
    expect(countCompactions(events)).toBe(1);
  });
});

describe("parsers", () => {
  it("parses git porcelain including renames", () => {
    expect(parsePorcelain(" M src/a.ts\0R  new.ts\0old.ts\0?? x\\y.ts\0")).toEqual([
      { status: " M", path: "src/a.ts" },
      { status: "R ", path: "new.ts" },
      { status: "??", path: "x/y.ts" },
    ]);
  });
  it("picks Windows-runnable shims and versions", () => {
    expect(pickRunnable(["C:\\npm\\codex", "C:\\npm\\codex.cmd"])).toBe("C:\\npm\\codex.cmd");
    expect(firstVersion("codex-cli 0.46.0")).toBe("0.46.0");
    expect(firstVersion("nothing")).toBeNull();
  });
  it("reads skill frontmatter", () => {
    expect(parseSkillFile("---\nname: bounded-task-handoff\ndescription: Prepare tasks\n---\n# Body\n")).toEqual({ name: "bounded-task-handoff", description: "Prepare tasks", body: "# Body\n" });
  });
  it("summarises task history from activity, latest outcome per task", () => {
    const history = taskHistory([
      { timestamp: "2026-01-01T00:00:01Z", type: "qa-fail", taskId: "A", attempt: 1 },
      { timestamp: "2026-01-01T00:00:02Z", type: "qa-pass", taskId: "A", attempt: 2, qa: "All checks passed\nmore" },
      { timestamp: "2026-01-01T00:00:03Z", type: "blocked", taskId: "B", qa: "scope" },
    ]);
    expect(history.map((h) => [h.taskId, h.outcome, h.attempts])).toEqual([
      ["B", "blocked", 0],
      ["A", "approved", 2],
    ]);
    expect(history[1].summary).toBe("All checks passed");
  });
});

describe("engine startup errors", () => {
  it("surfaces the last Error line from engine output", async () => {
    const { lastError } = await import("../src/main/engine-errors");
    expect(lastError("noise\nError: Ollama context preflight failed for m: fetch failed\n    at x\nNode.js v24\n")).toBe("Error: Ollama context preflight failed for m: fetch failed");
    expect(lastError("Usage: npm start -- --workspace <repo>\n")).toBe("Usage: npm start -- --workspace <repo>");
    expect(lastError("")).toMatch(/No output/);
  });
});

describe("updater parsing", () => {
  it("reads ls-remote and log output", async () => {
    const { parseLsRemote, parseLog } = await import("../src/main/updater-parse");
    expect(parseLsRemote("abc123\trefs/heads/master\ndef\trefs/heads/dev\n", "master")).toBe("abc123");
    expect(parseLsRemote("", "master")).toBeNull();
    const log = "h1\x1f2026-10-12T10:00:00Z\x1fBeta 0.14.0\x1f- Pick any model\r\n- Fast tier\n\nCo-Authored-By: Claude <x@y>\n\x1e\nh2\x1f2026-10-11T10:00:00Z\x1fInit\x1f\x1e\n";
    expect(parseLog(log)).toEqual([
      { hash: "h1", date: "2026-10-12T10:00:00Z", subject: "Beta 0.14.0", body: "- Pick any model\n- Fast tier" },
      { hash: "h2", date: "2026-10-11T10:00:00Z", subject: "Init", body: "" },
    ]);
  });
});

describe("provider limits", () => {
  it("parses a real Codex account/rateLimits/read result", async () => {
    const { parseCodexLimits } = await import("../src/main/lib/limits-parse");
    const snap = { limitId: "codex", primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1791815431 }, secondary: { usedPercent: 61, windowDurationMins: 10080, resetsAt: 1792299024 }, credits: { hasCredits: false, unlimited: false, balance: "0" }, planType: "plus", rateLimitReachedType: null, spendControlReached: false };
    const r = parseCodexLimits({ ordinaryUsageAllowed: true, rateLimits: snap, rateLimitsByLimitId: { codex: snap }, rateLimitResetCredits: { availableCount: 2 } }, "t");
    expect(r.plan).toBe("plus");
    expect(r.status).toBe("ok");
    expect(r.windows.map((w) => [w.label, w.usedPercent, w.resetsAt])).toEqual([
      ["5-hour window", 0, new Date(1791815431000).toISOString()],
      ["Weekly", 61, new Date(1792299024000).toISOString()],
    ]);
    expect(r.extras).toEqual([{ label: "Credits", value: "None" }, { label: "Reset credits", value: "2 available" }]);
    const blocked = parseCodexLimits({ ordinaryUsageAllowed: false, rateLimits: { ...snap, rateLimitReachedType: "rate_limit_reached" } }, "t");
    expect(blocked.status).toBe("limited");
  });
  it("parses a real Claude Code rate_limit_event", async () => {
    const { parseClaudeRateLimit, lastRateLimitEvent } = await import("../src/main/lib/limits-parse");
    const line = JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", resetsAt: 1791810000, rateLimitType: "five_hour", utilization: 0.96, overageStatus: "rejected", isUsingOverage: false, unifiedWindows: { five_hour: { utilization: 0.96, resetsAt: 1791810000 }, seven_day: { utilization: 0.38, resetsAt: 1792303200 } } } });
    const info = lastRateLimitEvent(`{"type":"system"}\n${line}\n{"type":"result"}`);
    expect(info).not.toBeNull();
    const r = parseClaudeRateLimit(info!, "t");
    expect(r.status).toBe("warning");
    expect(r.windows.map((w) => [w.label, w.usedPercent])).toEqual([["5-hour window", 96], ["Weekly", 38]]);
    expect(r.extras).toEqual([{ label: "Overage", value: "Not available" }]);
    expect(lastRateLimitEvent('{"type":"result"}')).toBeNull();
  });
});
