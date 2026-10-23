import path from "node:path";
import { safeStorage } from "electron";
import type { Agent, CliConnection, Project, Settings } from "@shared/types";
import { normalizeAppearance } from "@shared/appearance";
import { DEFAULT_CLIS, DEFAULT_SETTINGS, FORMER_SOURCE, SOURCE_URL, upgradeSafety } from "./defaults";
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
    general: { ...DEFAULT_SETTINGS.general, ...(s.general ?? {}), ...normalizeAppearance(s.general ?? {}) },
    workflow: { ...DEFAULT_SETTINGS.workflow, ...(s.workflow ?? {}) },
    attention: { ...DEFAULT_SETTINGS.attention, ...(s.attention ?? {}) },
    context: { ...DEFAULT_SETTINGS.context, ...(s.context ?? {}) },
    safety: upgradeSafety(s.safety),
    usage: { ...DEFAULT_SETTINGS.usage, ...(s.usage ?? {}) },
    advanced: { ...DEFAULT_SETTINGS.advanced, ...(s.advanced ?? {}) },
    skills: { ...DEFAULT_SETTINGS.skills, ...(s.skills ?? {}) },
    // The source repository was briefly named Agent-Dock-Dev; a source saved then points back at its real name.
    updates: { ...DEFAULT_SETTINGS.updates, ...(s.updates ?? {}), ...(FORMER_SOURCE.test(s.updates?.source ?? "") ? { source: SOURCE_URL } : {}) },
    tuning: { ...DEFAULT_SETTINGS.tuning, ...(s.tuning ?? {}) },
  };
}

/** Why a secret could not be saved: each OS keeps the encryption key somewhere else. */
const ENCRYPTION_UNAVAILABLE: Record<string, string> = {
  win32: "Windows credential encryption is unavailable; the key was not saved.",
  linux: "No keyring is available (GNOME Keyring or KWallet, unlocked in this session); the key was not saved. Start a keyring and try again.",
  darwin: "The macOS Keychain is unavailable; the key was not saved.",
  default: "This system has no credential store Agent Dock can use; the key was not saved.",
};

const ENV_SECRET_PREFIX = "env:";
const envSecretId = (cliId: string, key: string) => `${ENV_SECRET_PREFIX}${cliId}:${key}`;

/** All persistent app configuration, as JSON files under the Electron userData folder. */
export class AppStore {
  readonly dir: string;
  data!: Persisted;
  /** No saved connections or agents: a first launch, which discovers what this computer has. */
  fresh = false;
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
    // Saved connections are used as they are: removed ones stay removed. A first launch starts empty and
    // discovers what is installed. Agents saved before connections were (older versions kept every known
    // connection without saving it) keep that full list, so they still find their CLIs.
    this.fresh = clis === null && agents === null;
    // Those older versions also put llama.cpp on port 8081, not llama-server's own 8080.
    const legacy = () => structuredClone(DEFAULT_CLIS).map((c) => (c.kind === "llamacpp" ? { ...c, location: "http://127.0.0.1:8081/v1" } : c));
    const savedClis = clis ?? (agents === null ? [] : legacy());
    this.data = { projects, agents, clis: savedClis, settings: mergeSettings(settings) };
    this.secrets = secrets;
    // Secret environment values are kept encrypted beside the other secrets; older files had them in clis.json.
    this.data.clis = this.data.clis.map((c) => ({ ...c, env: (c.env ?? []).map((e) => (e.secret && !e.value ? { ...e, value: this.getSecret(envSecretId(c.id, e.key)) ?? "" } : e)) }));
    if (clis?.some((c) => c.env?.some((e) => e.secret && e.value))) await this.saveClis();
  }

  saveProjects() {
    return writeJson(this.file("projects"), this.data.projects);
  }
  saveAgents() {
    return writeJson(this.file("agents"), this.data.agents);
  }
  /** clis.json never holds a secret environment value: those go encrypted into secrets.json (in plain text only where the OS has no credential store). */
  async saveClis() {
    if (!safeStorage.isEncryptionAvailable()) return writeJson(this.file("clis"), this.data.clis);
    const kept = new Set<string>();
    const persisted = this.data.clis.map((c) => ({
      ...c,
      env: c.env.map((e) => {
        if (!e.secret || !e.value) return e;
        const id = envSecretId(c.id, e.key);
        kept.add(id);
        if (this.getSecret(id) !== e.value) this.secrets[id] = safeStorage.encryptString(e.value).toString("base64");
        return { ...e, value: "" };
      }),
    }));
    for (const id of Object.keys(this.secrets)) if (id.startsWith(ENV_SECRET_PREFIX) && !kept.has(id)) delete this.secrets[id];
    await writeJson(this.file("secrets"), this.secrets);
    return writeJson(this.file("clis"), persisted);
  }
  saveSettings() {
    return writeJson(this.file("settings"), this.data.settings);
  }

  /** Secrets are encrypted with Windows DPAPI through Electron safeStorage and never leave the main process. */
  async setSecret(id: string, value: string | null): Promise<void> {
    if (value === null || value === "") delete this.secrets[id];
    else {
      if (!safeStorage.isEncryptionAvailable()) throw new Error(ENCRYPTION_UNAVAILABLE[process.platform] ?? ENCRYPTION_UNAVAILABLE.default);
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
