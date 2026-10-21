import { describe, expect, it } from "vitest";
import { DEFAULT_CLIS, DEFAULT_SETTINGS, defaultAgents } from "../src/shared/defaults";
import { exportSettings, mergeImport, parseSettingsFile } from "../src/main/settings-transfer";
import type { CliConnection, Settings, WorkflowRole } from "../src/shared/types";

const agents = () => defaultAgents({ qa: "gpt-6.1-sol", assessment: "gpt-6.1-sol", elevate: "gpt-6-astra", reasoning: "medium" });
const settings = (): Settings => ({ ...structuredClone(DEFAULT_SETTINGS), activeProjectId: "p1", onboardingComplete: true });
const role: WorkflowRole = { id: "security-review", name: "Security review", description: "d", stage: "before-qa", gate: true, enabled: true, instructions: "Check auth.", dir: "C:\\roles\\security-review", warnings: [] };

function clis(): CliConnection[] {
  const list = structuredClone(DEFAULT_CLIS) as CliConnection[];
  list[0] = { ...list[0], location: "C:\\Tools\\codex.exe", hasSecret: true, env: [{ key: "OPENAI_API_KEY", value: "sk-live-123456789", secret: true }, { key: "MODE", value: "x", secret: false }], collected: { at: "t", source: "s", models: [] } as never, modelsDir: "C:\\models" };
  return list;
}

describe("settings export and import", () => {
  it("exports agents, roles, connections and settings without secrets, projects or machine-local settings", () => {
    const s = settings();
    s.updates.source = "E:\\src"; s.updates.branch = "dev"; s.general.defaultProject = "p1"; s.skills.importedDirs = ["C:\\skills"];
    s.workflow.unattended = true;
    const file = exportSettings({ settings: s, agents: agents(), clis: clis(), roles: [role], appVersion: "0.23.8", now: new Date("2026-10-18T00:00:00Z") });
    const text = JSON.stringify(file);
    expect(text).not.toContain("sk-live-123456789");
    expect(text).not.toMatch(/activeProjectId|onboardingComplete|importedDirs|defaultProject|E:\\\\src|C:\\\\models|hasSecret|"collected"/);
    expect(file.settings.workflow?.unattended).toBe(true);
    expect(file.clis[0].env).toEqual([{ key: "OPENAI_API_KEY", value: "", secret: true }, { key: "MODE", value: "x", secret: false }]);
    expect(file.roles).toEqual([{ id: "security-review", name: "Security review", description: "d", stage: "before-qa", gate: true, enabled: true, instructions: "Check auth." }]);
    expect(parseSettingsFile(text).appVersion).toBe("0.23.8");
  });

  it("refuses anything that is not a valid settings export", () => {
    expect(() => parseSettingsFile("nope")).toThrow(/not valid JSON/);
    expect(() => parseSettingsFile(JSON.stringify({ format: "other" }))).toThrow(/not an Agent Dock settings export/);
    expect(() => parseSettingsFile(JSON.stringify({ format: "agent-dock-settings", version: 2 }))).toThrow(/version 2 is not supported/);
    const ok = { format: "agent-dock-settings", version: 1, exportedAt: "t", appVersion: "v", settings: {}, agents: [], clis: [], roles: [] };
    expect(() => parseSettingsFile(JSON.stringify({ ...ok, roles: [{ id: "../evil", name: "x", instructions: "" }] }))).toThrow(/invalid workflow role/);
    expect(() => parseSettingsFile(JSON.stringify({ ...ok, agents: [{ id: 1 }] }))).toThrow(/invalid agent/);
    expect(parseSettingsFile(JSON.stringify(ok)).agents).toEqual([]);
  });

  it("imports on top of this machine: keeps local paths, secrets, projects and setup state; adds or replaces by id", () => {
    const other = settings();
    other.workflow.toolGuard = false; other.safety.protectedPaths = [".env*"]; other.general.theme = "darker";
    const theirAgents = agents().map((a) => (a.role === "qa" ? { ...a, model: "gpt-6.2" } : a));
    theirAgents.push({ ...theirAgents[1], id: "extra", name: "Extra" });
    const theirClis = clis().map((c, i) => (i === 0 ? { ...c, location: "D:\\elsewhere\\codex.exe", startupTimeoutSeconds: 99 } : c));
    theirClis.push({ ...theirClis[1], id: "new-cli", name: "New", env: [{ key: "TOKEN", value: "leaked", secret: true }] });
    const file = parseSettingsFile(JSON.stringify(exportSettings({ settings: other, agents: theirAgents, clis: theirClis, roles: [role], appVersion: "0.23.8" })));
    const mine = settings();
    mine.updates.source = "E:\\mine"; mine.skills.importedDirs = ["C:\\my-skills"]; mine.general.defaultProject = "p9";
    const local = { settings: mine, agents: [...agents(), { ...agents()[0], id: "local-only", name: "Local" }], clis: clis() };
    const r = mergeImport(local, file);
    expect(r.settings.workflow.toolGuard).toBe(true);
    expect(r.settings.safety.protectedPaths).toEqual(mine.safety.protectedPaths);
    expect(r.settings.general.theme).toBe("darker");
    expect(r.settings.workflow.unattendedLimits).toEqual(mine.workflow.unattendedLimits);
    expect([r.settings.activeProjectId, r.settings.onboardingComplete, r.settings.updates.source, r.settings.general.defaultProject]).toEqual(["p1", true, "E:\\mine", "p9"]);
    expect(r.settings.skills.importedDirs).toEqual(["C:\\my-skills"]);
    expect(r.agents.find((a) => a.role === "qa")!.model).toBe("gpt-6.2");
    expect(r.agents.map((a) => a.id)).toEqual(expect.arrayContaining(["extra", "local-only"]));
    const codex = r.clis[0];
    expect([codex.location, codex.startupTimeoutSeconds, codex.hasSecret, codex.modelsDir]).toEqual(["C:\\Tools\\codex.exe", 99, true, "C:\\models"]);
    expect(codex.env.find((e) => e.key === "OPENAI_API_KEY")!.value).toBe("sk-live-123456789");
    const added = r.clis.find((c) => c.id === "new-cli")!;
    expect([added.hasSecret, added.env[0].value]).toEqual([false, ""]);
    expect(r.roles.map((x) => x.id)).toEqual(["security-review"]);
    expect(r.summary).toEqual({ agents: theirAgents.length, clis: theirClis.length, roles: 1, skipped: ["Tool guard off", "Codex CLI location"] });
  });

  it("never takes programs to start from the file, keeps the tool guard on and adds protected paths", () => {
    const other = settings();
    other.advanced.llamaCppLauncher = "D:\\x\\start.cmd"; other.advanced.nodeRuntime = "electron";
    other.safety.protectedPaths = ["deploy/", ".env*"]; other.workflow.toolGuard = false;
    const theirClis = clis().map((c) => ({ ...c, location: `D:\\x\\${c.kind}.exe` }));
    theirClis.push({ ...theirClis[2], id: "claude-2", name: "Claude 2" }, { ...theirClis[4], id: "llama-2", name: "Llama 2", location: "http://10.0.0.5:8080/v1" });
    const file = parseSettingsFile(JSON.stringify(exportSettings({ settings: other, agents: [], clis: theirClis, roles: [], appVersion: "0.36.0" })));
    const mine = settings();
    mine.safety.protectedPaths = [".git/", "mine/"];
    const r = mergeImport({ settings: mine, agents: [], clis: clis() }, file);
    expect([r.settings.advanced.llamaCppLauncher, r.settings.advanced.nodeRuntime]).toEqual(["", "system"]);
    expect(r.settings.workflow.toolGuard).toBe(true);
    expect(r.settings.safety.protectedPaths).toEqual([".git/", "mine/", "deploy/", ".env*"]);
    expect(r.clis.map((c) => c.location)).toEqual([...clis().map((c) => c.location), "claude", "http://10.0.0.5:8080/v1"]);
    expect(r.summary.skipped).toEqual(expect.arrayContaining(["llama.cpp launcher", "Node runtime", "Tool guard off", "Codex CLI location", "Claude 2 location"]));
    expect(r.summary.skipped).not.toContain("Llama 2 location");
    // A guard that is off here stays off: the file only cannot weaken it.
    mine.workflow.toolGuard = false;
    expect(mergeImport({ settings: mine, agents: [], clis: [] }, file).settings.workflow.toolGuard).toBe(false);
  });

  it("imports the interface style and its accents; an invalid style or accent falls back to the default", () => {
    const other = settings();
    other.general.style = "cyberpunk"; other.general.styleAccents = { standard: "#A78BFA", cyberpunk: "#FF3864" };
    const file = parseSettingsFile(JSON.stringify(exportSettings({ settings: other, agents: [], clis: [], roles: [], appVersion: "0.36.0" })));
    const r = mergeImport({ settings: settings(), agents: [], clis: [] }, file);
    expect([r.settings.general.style, r.settings.general.styleAccents]).toEqual(["cyberpunk", { standard: "#A78BFA", cyberpunk: "#FF3864" }]);
    const bad = { ...file, settings: { general: { style: "glass", accent: "blue" } as unknown as Settings["general"] } };
    const b = mergeImport({ settings: settings(), agents: [], clis: [] }, bad);
    expect([b.settings.general.style, b.settings.general.accent, b.settings.general.styleAccents]).toEqual(["neumorphic", "#82A9E8", DEFAULT_SETTINGS.general.styleAccents]);
  });
});
