import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineEvent, Project, Settings } from "@shared/types";
import { currentSafetyPreset, SAFETY_PRESETS } from "../src/shared/safety-presets";
import { upgradeSafety } from "../src/shared/defaults";
import { buildEngineArgs } from "../src/main/lib/engine-args";
import { DEFAULT_CLIS, DEFAULT_SETTINGS, defaultAgents } from "../src/main/defaults";
import { sanitizeSettings, weakenings } from "../src/main/settings-validate";
import { decideActionRequest, readActionRequests } from "../src/main/lib/action-requests";
import { pendingMissingTools, pendingTaskApproval } from "../src/main/lib/status";

const project: Project = { id: "p1", name: "orbit", path: "E:\\dev\\orbit", repoUrl: null, objective: "Ship it", description: "", createdAt: "", archived: false, stateDir: "C:\\state\\p1", roleOverrides: {}, workflowOverrides: {} };
const agents = () => defaultAgents({ qa: "gpt-6.1-sol", assessment: "gpt-6.1-sol", elevate: "gpt-6-astra", reasoning: "medium" }).map((a) => (a.role === "implementation" ? { ...a, model: "m" } : a));
const settings = (edit: (s: Settings) => void = () => {}) => { const s = structuredClone(DEFAULT_SETTINGS); edit(s); return s; };
const args = (s: Settings, remoteApprovals = false) => buildEngineArgs({ project, agents: agents(), clis: structuredClone(DEFAULT_CLIS), settings: s, remoteApprovals }).args;
const value = (a: string[], flag: string) => (a.includes(flag) ? a[a.indexOf(flag) + 1] : undefined);

describe("safety levels", () => {
  it("the defaults are Standard; a changed toggle reads Custom; Strict asks for everything", () => {
    expect(currentSafetyPreset(DEFAULT_SETTINGS)).toBe("standard");
    expect(currentSafetyPreset(settings((s) => { s.safety.askMinutes = 5; }))).toBeNull();
    expect(currentSafetyPreset(settings((s) => { s.safety.checksTrusted = true; }))).toBe("trusted");
    expect(SAFETY_PRESETS.strict).toMatchObject({ toolGuard: true, approveTasks: true, sandboxChecks: true, sandboxAgents: true, askMinutes: 0 });
    for (const preset of Object.values(SAFETY_PRESETS)) expect(preset.toolGuard).toBe(true);
  });
  it("settings saved by 0.38 get the new fields' defaults, so they read Standard, not Custom", () => {
    const old = upgradeSafety({ protectedPaths: [".git/"], toolConfigPathsAdded: true, checksTrusted: false });
    expect(old).toMatchObject({ askMinutes: 10, sandboxChecks: false, sandboxAgents: false, protectedPaths: [".git/"] });
    expect(currentSafetyPreset({ ...structuredClone(DEFAULT_SETTINGS), safety: old })).toBe("standard");
  });
});

describe("web access for agents", () => {
  it("off in every safety level, so it is your own opt-in; turning it on is a change you confirm", () => {
    expect(args(settings())).not.toContain("--web-access");
    expect(value(args(settings((s) => { s.safety.webAccess = true; })), "--web-access")).toBe("true");
    expect(SAFETY_PRESETS.strict.webAccess).toBe(false);
    expect(SAFETY_PRESETS.standard.webAccess).toBe(false);
    expect(SAFETY_PRESETS.trusted.webAccess).toBe(false);
    const on = settings((s) => { s.safety.webAccess = true; });
    expect(weakenings(DEFAULT_SETTINGS, on).map((w) => w.label)).toContain("Let agents search the web and read web pages");
    // Settings with no value (older versions read none as on) are off.
    expect(weakenings(settings((s) => { delete s.safety.webAccess; }), on).map((w) => w.label)).toContain("Let agents search the web and read web pages");
  });
  it("0.39.0 had it on by default: an upgrade turns it off once, and a later choice is kept", () => {
    expect(upgradeSafety({ protectedPaths: [".git/"], toolConfigPathsAdded: true, askMinutes: 10, webAccess: true })).toMatchObject({ webAccess: false, webAccessReset: true });
    expect(upgradeSafety({ protectedPaths: [".git/"], toolConfigPathsAdded: true, webAccess: true, webAccessReset: true }).webAccess).toBe(true);
    expect(upgradeSafety({ protectedPaths: [".git/"], toolConfigPathsAdded: true, webAccessReset: true }).webAccess).toBe(false);
  });
});

describe("ask instead of refuse: engine arguments", () => {
  it("asks in attended runs; unattended only where Telegram can answer; 0 never asks", () => {
    expect(value(args(settings()), "--ask-minutes")).toBe("10");
    expect(value(args(settings((s) => { s.safety.askMinutes = 0; })), "--ask-minutes")).toBeUndefined();
    const unattended = settings((s) => { s.workflow.unattended = true; s.workflow.unattendedLimits = { ...s.workflow.unattendedLimits, maxCorrections: 2 }; });
    expect(value(args(unattended), "--ask-minutes")).toBeUndefined();
    expect(value(args(unattended, true), "--ask-minutes")).toBe("10");
  });
  it("a window save keeps the time between 0 and 60 minutes", () => {
    expect(sanitizeSettings(settings((s) => { s.safety.askMinutes = 999; }), DEFAULT_SETTINGS).safety.askMinutes).toBe(60);
    expect(sanitizeSettings(settings((s) => { s.safety.askMinutes = -3; }), DEFAULT_SETTINGS).safety.askMinutes).toBe(0);
  });
});

describe("approve each task: engine arguments", () => {
  it("waits for approval one task at a time, and never in unattended mode", () => {
    const on = args(settings((s) => { s.workflow.approveTasks = true; s.workflow.parallelTasks = 3; }));
    expect(value(on, "--approve-tasks")).toBe("true");
    expect(on).not.toContain("--parallel");
    expect(args(settings((s) => { s.workflow.approveTasks = true; s.workflow.unattended = true; s.workflow.unattendedLimits = { ...s.workflow.unattendedLimits, maxCorrections: 2 }; }))).not.toContain("--approve-tasks");
    expect(args(settings())).not.toContain("--approve-tasks");
  });
  it("the waiting task is the newest request with no answer, stop or block after it, while the engine runs", () => {
    const ev = (type: string, extra: Record<string, unknown> = {}) => ({ timestamp: new Date().toISOString(), type, ...extra }) as EngineEvent;
    const asked = ev("task-approval-requested", { taskId: "T1", name: "Do it", objective: "o", allowedPaths: ["a.js"], qaCommand: "npm test" });
    expect(pendingTaskApproval([asked], true)).toMatchObject({ taskId: "T1", allowedPaths: ["a.js"], qaCommand: "npm test" });
    expect(pendingTaskApproval([asked], false)).toBeNull();
    for (const after of ["task-approved", "task-deferred", "stopped", "blocked"]) expect(pendingTaskApproval([asked, ev(after, { taskId: "T1" })], true)).toBeNull();
  });
});

describe("ask instead of refuse: requests", () => {
  const request = (dir: string, id: string, expiresIn = 60_000) => writeFileSync(join(dir, `${id}.request.json`), JSON.stringify({ id, cli: "Codex", tool: "Bash", text: "rg --files", reason: "r", cwd: "x", taskId: "T1", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + expiresIn).toISOString() }));
  it("lists unanswered, unexpired requests; the first answer wins; bad ids are refused", async () => {
    const state = mkdtempSync(join(tmpdir(), "dock-ask-")), dir = join(state, "approvals");
    mkdirSync(dir);
    const a = "a".repeat(32), b = "b".repeat(32), c = "c".repeat(32);
    request(dir, a); request(dir, b, -1); request(dir, c);
    writeFileSync(join(dir, `${c}.done.json`), "{}");
    expect((await readActionRequests(state)).map((r) => r.id)).toEqual([a]);
    expect(await decideActionRequest(state, a, "allow", "app")).toBe(true);
    expect(await decideActionRequest(state, a, "deny", "remote:telegram")).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, `${a}.decision.json`), "utf8"))).toMatchObject({ id: a, decision: "allow", by: "app" });
    expect(await decideActionRequest(state, b, "allow", "app")).toBe(false);
    expect(await decideActionRequest(state, "../../x", "allow", "app")).toBe(false);
    expect(await readActionRequests(state)).toEqual([]);
  });
  it("Allow for this run is an allow the engine remembers; a refusal never carries it", async () => {
    const state = mkdtempSync(join(tmpdir(), "dock-ask-")), dir = join(state, "approvals");
    mkdirSync(dir);
    const a = "d".repeat(32), b = "e".repeat(32);
    request(dir, a); request(dir, b);
    expect(await decideActionRequest(state, a, "allow", "app", true)).toBe(true);
    expect(await decideActionRequest(state, b, "deny", "app", true)).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, `${a}.decision.json`), "utf8"))).toMatchObject({ decision: "allow", remember: true });
    expect(JSON.parse(readFileSync(join(dir, `${b}.decision.json`), "utf8")).remember).toBeUndefined();
  });
});

describe("missing tools", () => {
  it("the task waits while the newest tools-missing has no tools-ready, set-aside, stop or block after it", () => {
    const ev = (type: string, extra: Record<string, unknown> = {}) => ({ timestamp: new Date().toISOString(), type, ...extra }) as EngineEvent;
    const missing = ev("tools-missing", { taskId: "T1", qaCommand: "npm run test:rust", tools: [{ tool: "cargo", name: "Rust (cargo)", install: "winget install --id Rustlang.Rustup -e --source winget", url: "https://rustup.rs", note: null }] });
    expect(pendingMissingTools([missing], true)).toMatchObject({ taskId: "T1", qaCommand: "npm run test:rust", tools: [{ tool: "cargo", name: "Rust (cargo)" }] });
    expect(pendingMissingTools([missing], false)).toBeNull();
    for (const after of ["tools-ready", "task-deferred", "stopped", "blocked"]) expect(pendingMissingTools([missing, ev(after, { taskId: "T1" })], true)).toBeNull();
  });
});
