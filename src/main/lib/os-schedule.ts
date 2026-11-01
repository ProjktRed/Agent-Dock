import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

// Scheduled runs happen only while Agent Dock is open (from 0.39). Versions 0.35 to 0.38 could also put a
// project's schedule in Windows Task Scheduler, as a per-user task under "\Agent Dock\" that launched the
// app with --scheduled-run. This removes those tasks once, on the first launch after the upgrade.

export const TASK_FOLDER = "Agent Dock";

export interface OsTask {
  /** Task name without the leading backslash, e.g. "Agent Dock\Run p1". */
  name: string;
  /** The exe the task launches, without quotes; "" when it has no program action. */
  exe: string;
}

/**
 * Agent Dock's tasks in the task query's JSON (see QUERY_SCRIPT): `[{"name":"\\Agent Dock\\Run p1","exe":"…"}]`,
 * with the exe each one launches. Also takes a single object or nothing (what ConvertTo-Json prints for one
 * task or none) and keeps only tasks directly in the Agent Dock folder.
 */
export function parseTaskJson(json: string): OsTask[] {
  const text = json.replace(/^\uFEFF/, "").trim();
  if (!text) return [];
  const parsed: unknown = JSON.parse(text);
  const items = (Array.isArray(parsed) ? parsed : [parsed]) as ({ name?: unknown; exe?: unknown } | null)[];
  const prefix = `\\${TASK_FOLDER.toLowerCase()}\\`;
  const tasks = new Map<string, OsTask>();
  for (const item of items) {
    const name = typeof item?.name === "string" ? item.name : "";
    if (!name.toLowerCase().startsWith(prefix) || name.length === prefix.length || name.slice(prefix.length).includes("\\")) continue;
    const exe = typeof item?.exe === "string" ? item.exe.trim().replace(/^"+|"+$/g, "").trim() : "";
    tasks.set(name.toLowerCase(), { name: name.slice(1), exe });
  }
  return [...tasks.values()];
}

const samePath = (a: string, b: string) => a.replace(/\//g, "\\").toLowerCase() === b.replace(/\//g, "\\").toLowerCase();

/**
 * Whose a task is. Two installs on one PC (a release install and a developer build, say) can share the same
 * projects, so each removes only the tasks that launch its own exe. A task that launches another exe still on
 * disk is the other install's and is left alone; one whose exe is gone is stale and is removed too.
 */
export function taskOwner(task: OsTask, exe: string, exists: (file: string) => boolean): "mine" | "other" | "stale" {
  if (task.exe && samePath(task.exe, exe)) return "mine";
  return task.exe && exists(task.exe) ? "other" : "stale";
}

type Run = (args: string[]) => Promise<string>;
const schtasks: Run = (args) => new Promise((resolve, reject) => {
  execFile("schtasks.exe", args, { windowsHide: true, timeout: 20_000 }, (error, stdout, stderr) => (error ? reject(new Error(String(stderr || error.message).trim())) : resolve(stdout)));
});

// Reads only Agent Dock's folder, as UTF-8 JSON, through hidden PowerShell. Piped `schtasks /Query` output
// comes in the console code page (garbling paths like C:\Users\Zoë) and lists every task on the PC. A missing
// folder is no tasks; any other failure is an error, so nothing is removed.
const QUERY_SCRIPT = [
  "$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [Text.Encoding]::UTF8;",
  `try { $t = @(Get-ScheduledTask -TaskPath '\\${TASK_FOLDER}\\') } catch { if ($_.CategoryInfo.Category -ne 'ObjectNotFound') { throw }; $t = @() };`,
  "ConvertTo-Json -Compress -InputObject @($t | ForEach-Object { [pscustomobject]@{ name = $_.TaskPath + $_.TaskName; exe = $_.Actions[0].Execute } })",
].join(" ");
const POWERSHELL = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
const queryTasks = (): Promise<string> => new Promise((resolve, reject) => {
  execFile(POWERSHELL, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", QUERY_SCRIPT], { windowsHide: true, timeout: 30_000, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
    (error, stdout, stderr) => (error ? reject(new Error(String(stderr || error.message).trim())) : resolve(stdout)));
});

/**
 * Deletes the scheduled-run tasks an earlier version of this install made, and stale ones; another install's
 * tasks are left alone. Returns the problems (an empty list when everything is removed).
 */
export async function removeOsSchedules(exe: string, run: Run = schtasks, exists: (file: string) => boolean = existsSync, query: () => Promise<string> = queryTasks): Promise<string[]> {
  let existing: OsTask[];
  // Without the current tasks there is no telling whose they are, so nothing is removed.
  try { existing = parseTaskJson(await query()); } catch (error) { return [`Reading the scheduled tasks: ${(error as Error).message}`]; }
  const problems: string[] = [];
  for (const { name } of existing.filter((t) => taskOwner(t, exe, exists) !== "other")) {
    try { await run(["/Delete", "/F", "/TN", name]); } catch (error) { problems.push(`Removing ${name}: ${(error as Error).message}`); }
  }
  return problems;
}
