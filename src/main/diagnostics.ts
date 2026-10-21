import { open, readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Agent, CliConnection, Project, Settings, WorkflowRole } from "@shared/types";
import type { ZipEntry } from "./lib/zip";

// Diagnostics export: what a bug report needs (versions, configuration, each project's engine state,
// recent Activity and engine log), with every secret removed. Never included: stored secrets, project
// source code and diffs (qa-packet.json, codex/ prompts), the hash-chained action log itself (only
// whether it verifies), and set-aside stashes.

/** Engine state files copied as they are (after redaction), when present. */
export const STATE_FILES = [
  "live.json", "control.json", "current-task.json", "last-result.json", "loop-result.json", "pending-codex.json",
  "run-report.json", "run-report.md", "plan-proposals.json", "deferred-tasks.json", "workflow-roles.json",
  "supervisor-digest.md", "usage-day.json", "app-engine.json", "task-board.json", "parallel-round.json", "run-usage.json", "estimates.json",
];
const ACTIVITY_LINES = 2000;
const LOG_BYTES = 512 * 1024;
const RUNS = 10;

export interface DiagnosticsInput {
  about: Record<string, unknown>;
  settings: Settings;
  agents: Agent[];
  clis: CliConnection[];
  roles: WorkflowRole[];
  projects: Project[];
  statuses: Record<string, unknown>;
  /** Verifies a project's action log (engine/src/action-log.mjs verifyActionLog). */
  verifyActionLog?: (stateDir: string) => Promise<unknown>;
  /** Extra logs outside the projects, by name in the archive (for example the updater's swap log). */
  logs?: Record<string, string>;
  /** Engine redaction (exact secret values plus credential patterns). */
  redact: (text: string) => string;
}

/** Folder-safe, unique name for each project inside the archive. */
function folderName(project: Project, used: Set<string>) {
  const base = (project.name || "project").replace(/[^\w .-]+/g, "_").trim().slice(0, 60) || "project";
  let name = base;
  for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base} (${n})`;
  used.add(name.toLowerCase());
  return name;
}

async function tailBytes(file: string, bytes: number): Promise<string | null> {
  try {
    const size = (await stat(file)).size;
    const handle = await open(file, "r");
    try {
      const length = Math.min(size, bytes);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, size - length);
      const text = buffer.toString("utf8");
      // Start on a whole line when the file was cut.
      return size > bytes ? text.slice(text.indexOf("\n") + 1) : text;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

async function tailLines(file: string, lines: number, bytes = 8 * 1024 * 1024): Promise<string | null> {
  const text = await tailBytes(file, bytes);
  if (text === null) return null;
  return text.split(/\r?\n/).filter(Boolean).slice(-lines).join("\n") + "\n";
}

/** The user's home folder, in both slash styles, so paths in the export do not carry the account name. */
export function homeMasker(home = os.homedir()) {
  const forms = [...new Set([home, home.replace(/\\/g, "/"), home.replace(/\\/g, "\\\\")])].filter((h) => h.length > 3).sort((a, b) => b.length - a.length);
  return (text: string) => forms.reduce((out, h) => out.split(h).join("~"), text);
}

/** Connections without secret environment values (names stay, so a missing variable is still visible). */
export function safeClis(clis: CliConnection[]) {
  return clis.map((c) => ({ ...c, env: c.env.map((e) => (e.secret ? { ...e, value: e.value ? "[secret]" : "" } : e)) }));
}

/** The archive's files. Each text passes through the engine redaction and the home-folder mask. */
export async function collectDiagnostics(input: DiagnosticsInput): Promise<ZipEntry[]> {
  const mask = homeMasker();
  const clean = (text: string) => mask(input.redact(text));
  const json = (value: unknown) => clean(JSON.stringify(value, null, 2)) + "\n";
  const entries: ZipEntry[] = [];
  const add = (name: string, text: string) => entries.push({ name, data: text });
  add("about.json", json(input.about));
  add("config/settings.json", json(input.settings));
  add("config/agents.json", json(input.agents));
  add("config/clis.json", json(safeClis(input.clis)));
  add("config/roles.json", json(input.roles));
  add("config/projects.json", json(input.projects));
  const used = new Set<string>();
  const index: { name: string; folder: string; archived: boolean }[] = [];
  for (const project of input.projects) {
    const folder = `projects/${folderName(project, used)}`;
    index.push({ name: project.name, folder, archived: project.archived });
    add(`${folder}/status.json`, json(input.statuses[project.id] ?? null));
    for (const name of STATE_FILES) {
      const text = await readFile(path.join(project.stateDir, name), "utf8").catch(() => null);
      if (text !== null) add(`${folder}/state/${name}`, clean(text));
    }
    const activity = await tailLines(path.join(project.stateDir, "activity.ndjson"), ACTIVITY_LINES);
    if (activity) add(`${folder}/activity-tail.ndjson`, clean(activity));
    const log = await tailBytes(path.join(project.stateDir, "app-engine.log"), LOG_BYTES);
    if (log) add(`${folder}/app-engine-tail.log`, clean(log));
    const runs = (await readdir(path.join(project.stateDir, "runs")).catch(() => [] as string[])).filter((n) => n.endsWith(".json")).sort().slice(-RUNS);
    for (const name of runs) {
      const text = await readFile(path.join(project.stateDir, "runs", name), "utf8").catch(() => null);
      if (text !== null) add(`${folder}/runs/${name}`, clean(text));
    }
    if (input.verifyActionLog) {
      const verified = await input.verifyActionLog(project.stateDir).catch((error: unknown) => ({ ok: false, reason: String((error as Error)?.message ?? error) }));
      add(`${folder}/action-log-verify.json`, json(verified));
    }
  }
  for (const [name, file] of Object.entries(input.logs ?? {})) {
    const text = await tailBytes(file, LOG_BYTES);
    if (text) add(`logs/${name}`, clean(text));
  }
  add("README.txt", [
    "Agent Dock diagnostics",
    "",
    "Versions, configuration, and for each project its engine state, the newest Activity and engine log, and recent run reports.",
    "Secrets were removed: stored API keys and tokens, notification addresses, secret environment values, and anything that looks like a credential.",
    "Not included: project source code and diffs, model prompts, the action log itself (only whether it verifies).",
    "Your home folder is shown as ~. Look through the files before you share them.",
    "",
    ...index.map((p) => `${p.folder}: ${p.name}${p.archived ? " (archived)" : ""}`),
    "",
  ].join("\n"));
  return entries;
}
