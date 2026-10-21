import type { Agent, CliConnection, Settings, WorkflowRole } from "@shared/types";
import { normalizeAppearance } from "@shared/appearance";

// Settings export and import (Settings › Advanced): carry agents, workflow roles, connections and
// settings to another machine or share a setup. Never included: stored secrets (API keys, notification
// addresses), secret environment values, projects (local paths and engine state), and machine-local
// settings (active project, setup status, skill folders, update source).

export const SETTINGS_FORMAT = "agent-dock-settings";
type PortableRole = Pick<WorkflowRole, "id" | "name" | "description" | "stage" | "gate" | "fix" | "enabled" | "instructions">;

export interface SettingsFile {
  format: typeof SETTINGS_FORMAT;
  version: 1;
  exportedAt: string;
  appVersion: string;
  settings: Partial<Settings>;
  agents: Agent[];
  clis: CliConnection[];
  roles: PortableRole[];
}

/** Settings that belong to this machine: kept on import, left out of an export. */
function portableSettings(settings: Settings): Partial<Settings> {
  const { activeProjectId: _active, onboardingComplete: _done, skills: _skills, ...rest } = settings;
  const { source: _source, branch: _branch, ...updates } = settings.updates;
  const { defaultProject: _project, ...general } = settings.general;
  return { ...rest, general: general as Settings["general"], updates: updates as Settings["updates"] };
}

export function exportSettings(input: { settings: Settings; agents: Agent[]; clis: CliConnection[]; roles: WorkflowRole[]; appVersion: string; now?: Date }): SettingsFile {
  return {
    format: SETTINGS_FORMAT,
    version: 1,
    exportedAt: (input.now ?? new Date()).toISOString(),
    appVersion: input.appVersion,
    settings: portableSettings(input.settings),
    agents: input.agents,
    // Secret variables keep their names, so the other machine shows which ones to fill in.
    clis: input.clis.map(({ collected: _models, hasSecret: _secret, modelsDir: _dir, ...c }) => ({ ...c, env: c.env.map((e) => (e.secret ? { ...e, value: "" } : e)) }) as CliConnection),
    roles: input.roles.map(({ id, name, description, stage, gate, fix, enabled, instructions }) => ({ id, name, description, stage, gate, ...(fix ? { fix: true } : {}), enabled, instructions })),
  };
}

const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** Validates an exported file; throws a readable message for anything else. */
export function parseSettingsFile(text: string): SettingsFile {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("This file is not valid JSON."); }
  if (!isObject(value) || value.format !== SETTINGS_FORMAT) throw new Error("This is not an Agent Dock settings export.");
  if (value.version !== 1) throw new Error(`Settings export version ${String(value.version)} is not supported by this version of Agent Dock.`);
  if (!isObject(value.settings) || !Array.isArray(value.agents) || !Array.isArray(value.clis) || !Array.isArray(value.roles)) throw new Error("The settings export is incomplete.");
  for (const a of value.agents) if (!isObject(a) || typeof a.id !== "string" || typeof a.role !== "string" || typeof a.cliId !== "string") throw new Error("The settings export has an invalid agent.");
  for (const c of value.clis) if (!isObject(c) || typeof c.id !== "string" || typeof c.kind !== "string" || !Array.isArray(c.env)) throw new Error("The settings export has an invalid connection.");
  for (const r of value.roles) if (!isObject(r) || typeof r.id !== "string" || !/^[\w-]{1,64}$/.test(r.id) || typeof r.name !== "string" || typeof r.instructions !== "string") throw new Error("The settings export has an invalid workflow role.");
  return value as unknown as SettingsFile;
}

export interface ImportResult {
  settings: Settings;
  agents: Agent[];
  clis: CliConnection[];
  roles: PortableRole[];
  summary: { agents: number; clis: number; roles: number };
}

/**
 * Applies an export on top of this machine. Settings are replaced except the machine-local ones.
 * Agents and roles with the same id are replaced, others added; nothing local is deleted.
 * Connections with the same id keep their local executable or URL, secret values and model lists.
 */
export function mergeImport(current: { settings: Settings; agents: Agent[]; clis: CliConnection[] }, file: SettingsFile): ImportResult {
  const incoming = file.settings;
  const local = current.settings;
  const general = { ...local.general, ...(incoming.general ?? {}), defaultProject: local.general.defaultProject };
  const settings: Settings = {
    ...local,
    ...incoming,
    general: { ...general, ...normalizeAppearance(general) },
    updates: { ...local.updates, ...(incoming.updates ?? {}), source: local.updates.source, branch: local.updates.branch },
    skills: local.skills,
    activeProjectId: local.activeProjectId,
    onboardingComplete: local.onboardingComplete,
  } as Settings;
  for (const key of ["workflow", "attention", "context", "safety", "usage", "tuning", "advanced"] as const) {
    if (isObject(incoming[key])) (settings as unknown as Record<string, unknown>)[key] = { ...(local[key] as object), ...(incoming[key] as object) };
  }
  const agents = [...current.agents];
  for (const agent of file.agents) {
    const at = agents.findIndex((a) => a.id === agent.id);
    if (at >= 0) agents[at] = agent;
    else agents.push(agent);
  }
  const clis = [...current.clis];
  for (const cli of file.clis) {
    const at = clis.findIndex((c) => c.id === cli.id);
    if (at < 0) { clis.push({ ...cli, hasSecret: false, modelsDir: null, collected: null, env: cli.env.map((e) => (e.secret ? { ...e, value: "" } : e)) }); continue; }
    const mine = clis[at];
    clis[at] = {
      ...cli,
      location: mine.location,
      builtIn: mine.builtIn,
      collected: mine.collected,
      hasSecret: mine.hasSecret,
      modelsDir: mine.modelsDir,
      env: cli.env.map((e) => (e.secret ? { ...e, value: mine.env.find((m) => m.key === e.key)?.value ?? "" } : e)),
    };
  }
  return { settings, agents, clis, roles: file.roles, summary: { agents: file.agents.length, clis: file.clis.length, roles: file.roles.length } };
}
