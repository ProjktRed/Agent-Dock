import path from "node:path";
import { safeStorage } from "electron";
import type { Agent, CliConnection, Project, Settings } from "@shared/types";
import { DEFAULT_CLIS, DEFAULT_SETTINGS, DEV_SOURCE, FORMER_SOURCE } from "./defaults";
import { readJson, writeJson } from "./lib/json-file";

interface Persisted {
  projects: Project[];
  agents: Agent[] | null;
  clis: CliConnection[];
  settings: Settings;
}

function mergeSettings(saved: Partial<Settings> | null): Settings {
  const s = saved ?? {};
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    general: { ...DEFAULT_SETTINGS.general, ...(s.general ?? {}) },
    workflow: { ...DEFAULT_SETTINGS.workflow, ...(s.workflow ?? {}) },
    attention: { ...DEFAULT_SETTINGS.attention, ...(s.attention ?? {}) },
    context: { ...DEFAULT_SETTINGS.context, ...(s.context ?? {}) },
    safety: { ...DEFAULT_SETTINGS.safety, ...(s.safety ?? {}) },
    usage: { ...DEFAULT_SETTINGS.usage, ...(s.usage ?? {}) },
    advanced: { ...DEFAULT_SETTINGS.advanced, ...(s.advanced ?? {}) },
    skills: { ...DEFAULT_SETTINGS.skills, ...(s.skills ?? {}) },
    // The source repository was renamed to Agent-Dock-Dev and its old name now holds the public releases.
    updates: { ...DEFAULT_SETTINGS.updates, ...(s.updates ?? {}), ...(FORMER_SOURCE.test(s.updates?.source ?? "") ? { source: DEV_SOURCE } : {}) },
    tuning: { ...DEFAULT_SETTINGS.tuning, ...(s.tuning ?? {}) },
  };
}

/** All persistent app configuration, as JSON files under the Electron userData folder. */
export class AppStore {
  readonly dir: string;
  data!: Persisted;
  private secrets: Record<string, string> = {};

  constructor(userData: string) {
    this.dir = path.join(userData, "config");
  }

  private file(name: string) {
    return path.join(this.dir, `${name}.json`);
  }

  async load(): Promise<void> {
    const [projects, agents, clis, settings, secrets] = await Promise.all([
      readJson<Project[]>(this.file("projects"), []),
      readJson<Agent[] | null>(this.file("agents"), null),
      readJson<CliConnection[] | null>(this.file("clis"), null),
      readJson<Partial<Settings> | null>(this.file("settings"), null),
      readJson<Record<string, string>>(this.file("secrets"), {}),
    ]);
    // Built-in connections are always present; saved edits win.
    const savedClis = clis ?? [];
    const mergedClis = [...DEFAULT_CLIS.map((d) => savedClis.find((c) => c.id === d.id) ?? d), ...savedClis.filter((c) => !c.builtIn)];
    this.data = { projects, agents, clis: mergedClis, settings: mergeSettings(settings) };
    this.secrets = secrets;
  }

  saveProjects() {
    return writeJson(this.file("projects"), this.data.projects);
  }
  saveAgents() {
    return writeJson(this.file("agents"), this.data.agents);
  }
  saveClis() {
    return writeJson(this.file("clis"), this.data.clis);
  }
  saveSettings() {
    return writeJson(this.file("settings"), this.data.settings);
  }

  /** Secrets are encrypted with Windows DPAPI through Electron safeStorage and never leave the main process. */
  async setSecret(id: string, value: string | null): Promise<void> {
    if (value === null || value === "") delete this.secrets[id];
    else {
      if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows credential encryption is unavailable; the key was not saved.");
      this.secrets[id] = safeStorage.encryptString(value).toString("base64");
    }
    await writeJson(this.file("secrets"), this.secrets);
  }

  getSecret(id: string): string | null {
    const value = this.secrets[id];
    if (!value) return null;
    try {
      return safeStorage.decryptString(Buffer.from(value, "base64"));
    } catch {
      return null;
    }
  }

  /** Every stored secret, decrypted: what a diagnostics export must never contain. */
  secretValues(): string[] {
    return Object.keys(this.secrets).map((id) => this.getSecret(id)).filter((v): v is string => Boolean(v));
  }

  hasSecret(id: string): boolean {
    return Boolean(this.secrets[id]);
  }
}
