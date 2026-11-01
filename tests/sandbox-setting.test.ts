import { describe, expect, it } from "vitest";
import type { Project, Settings } from "@shared/types";
import { buildEngineArgs } from "../src/main/lib/engine-args";
import { DEFAULT_CLIS, DEFAULT_SETTINGS, defaultAgents } from "../src/main/defaults";
import { sanitizeSettings } from "../src/main/settings-validate";
import { mergeImport } from "../src/main/settings-transfer";

const project: Project = { id: "p1", name: "orbit", path: "E:\\dev\\orbit", repoUrl: null, objective: "Ship it", description: "", createdAt: "", archived: false, stateDir: "C:\\state\\p1", roleOverrides: {}, workflowOverrides: {} };
const agents = () => defaultAgents({ qa: "gpt-6.1-sol", assessment: "gpt-6.1-sol", elevate: "gpt-6-astra", reasoning: "medium" }).map((a) => (a.role === "implementation" ? { ...a, model: "m" } : a));
const withSandbox = (on: boolean): Settings => { const s = structuredClone(DEFAULT_SETTINGS); s.safety = { ...s.safety, sandboxChecks: on }; return s; };

describe("sandbox for checks (Settings › Experimental)", () => {
  it("is off by default and reaches the engine only when on", () => {
    expect(DEFAULT_SETTINGS.safety.sandboxChecks).toBe(false);
    const args = (s: Settings) => buildEngineArgs({ project, agents: agents(), clis: structuredClone(DEFAULT_CLIS), settings: s }).args;
    expect(args(withSandbox(false))).not.toContain("--sandbox-checks");
    const on = args(withSandbox(true));
    expect(on[on.indexOf("--sandbox-checks") + 1]).toBe("true");
  });

  it("a save from the window cannot change it either way (only the setup and self-test in the main process do)", () => {
    expect(sanitizeSettings(withSandbox(true), withSandbox(false)).safety.sandboxChecks).toBe(false);
    expect(sanitizeSettings(withSandbox(false), withSandbox(true)).safety.sandboxChecks).toBe(true);
  });

  it("an import keeps this computer's value", () => {
    const file = (s: Settings) => ({ format: "agent-dock-settings", version: 1, exportedAt: "", appVersion: "", settings: s, agents: [], clis: [], roles: [] }) as never;
    expect(mergeImport({ settings: withSandbox(false), agents: [], clis: [] }, file(withSandbox(true))).settings.safety.sandboxChecks).toBe(false);
    expect(mergeImport({ settings: withSandbox(true), agents: [], clis: [] }, file(withSandbox(false))).settings.safety.sandboxChecks).toBe(true);
  });
});

describe("sandbox for agents' commands (Settings › Experimental)", () => {
  const agentsOn = (on: boolean): Settings => { const s = structuredClone(DEFAULT_SETTINGS); s.safety = { ...s.safety, sandboxAgents: on }; return s; };
  it("is off by default, reaches the engine only when on, and neither a window save nor an import changes it", () => {
    expect(DEFAULT_SETTINGS.safety.sandboxAgents).toBe(false);
    const args = buildEngineArgs({ project, agents: agents(), clis: structuredClone(DEFAULT_CLIS), settings: agentsOn(true) }).args;
    expect(args[args.indexOf("--sandbox-agents") + 1]).toBe("true");
    expect(buildEngineArgs({ project, agents: agents(), clis: structuredClone(DEFAULT_CLIS), settings: agentsOn(false) }).args).not.toContain("--sandbox-agents");
    expect(sanitizeSettings(agentsOn(true), agentsOn(false)).safety.sandboxAgents).toBe(false);
    const file = { format: "agent-dock-settings", version: 1, exportedAt: "", appVersion: "", settings: agentsOn(true), agents: [], clis: [], roles: [] } as never;
    expect(mergeImport({ settings: agentsOn(false), agents: [], clis: [] }, file).settings.safety.sandboxAgents).toBe(false);
  });
});
