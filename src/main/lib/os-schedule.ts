import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Project } from "@shared/types";
import { scheduleMinutes } from "@shared/schedule";

// Scheduled runs while Agent Dock is closed (0.35, Windows). A project's schedule can also be put in
// Windows Task Scheduler as a per-user task under "\Agent Dock\" that launches Agent Dock minimized with
// --scheduled-run at the scheduled time. The app then starts every project whose slot is due, exactly as
// its own once-a-minute check does, so a run never starts twice. No admin rights or service: the task
// runs only while you are signed in, as you.
//
// The task is created from a Task Scheduler XML definition (taskXml) rather than schtasks' /SC options,
// whose defaults skip the start on battery, never catch up a missed start and end the app after 72 hours.

export const TASK_FOLDER = "Agent Dock";
export const SCHEDULED_RUN_FLAG = "--scheduled-run";
const TASK_ARGUMENTS = `--minimized ${SCHEDULED_RUN_FLAG}`;
const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const DAY_ELEMENTS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export const taskName = (projectId: string) => `${TASK_FOLDER}\\Run ${projectId.replace(/[^\w-]/g, "_")}`;

/** Projects whose schedule should exist in Task Scheduler. */
export function wantsOsSchedule(p: Project): boolean {
  return !p.archived && p.schedule?.enabled === true && p.schedule.whenClosed === true && p.schedule.days?.length > 0 && scheduleMinutes(p.schedule.time) !== null;
}

const weekDays = (p: Project) => [...new Set(p.schedule!.days)].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort();

/**
 * schtasks arguments for the old weekly task with Task Scheduler's default settings. Used only when the
 * XML definition is refused: same name and action, so ownership and the uninstaller still find it.
 */
export function legacyTaskArgs(p: Project, exe: string): string[] {
  return ["/Create", "/F", "/TN", taskName(p.id), "/SC", "WEEKLY", "/D", weekDays(p).map((d) => DAYS[d]).join(","), "/ST", p.schedule!.time, "/TR", `"${exe}" ${TASK_ARGUMENTS}`];
}

/** schtasks arguments that create (or replace) the project's task from the XML file. */
export const createTaskArgs = (p: Project, xmlFile: string): string[] => ["/Create", "/XML", xmlFile, "/TN", taskName(p.id), "/F"];

/** Text as XML character data or an attribute value: escaped, without characters XML 1.0 cannot hold. */
export function xmlText(value: string): string {
  return String(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "")
    .replace(/[&<>"']/g, (c) => XML_ESCAPES[c]);
}
const XML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };

/**
 * The first start: the schedule's time today if still ahead, else tomorrow, as local time without a zone
 * (so it follows the PC's clock, as schtasks /ST does). Never in the past, so registering the task does
 * not count an earlier slot as a missed start to catch up.
 */
export function startBoundary(time: string, now: Date): string {
  const at = scheduleMinutes(time) ?? 0;
  const first = new Date(now.getFullYear(), now.getMonth(), now.getDate(), Math.floor(at / 60), at % 60);
  if (first.getTime() <= now.getTime()) first.setDate(first.getDate() + 1);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${first.getFullYear()}-${pad(first.getMonth() + 1)}-${pad(first.getDate())}T${pad(first.getHours())}:${pad(first.getMinutes())}:00`;
}

/**
 * The Task Scheduler definition of a project's weekly task. Runs on battery and keeps running if the PC
 * goes on battery; a start missed while the PC was off or asleep runs as soon as it can (the app still
 * skips it if that is past the grace period, and reports it); wakes the PC only when the project asks
 * (wakeToRun); no time limit, because the launched process is the app itself, which stays open; and a
 * second trigger while the app it launched is still open is ignored (the open app runs it).
 */
export function taskXml(p: Project, exe: string, now: Date = new Date()): string {
  const s = p.schedule!;
  const days = weekDays(p).map((d) => `<${DAY_ELEMENTS[d]} />`).join("");
  return [
    `<?xml version="1.0" encoding="UTF-16"?>`,
    `<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">`,
    `  <RegistrationInfo>`,
    `    <Author>Agent Dock</Author>`,
    `    <Description>${xmlText(`Starts Agent Dock's scheduled run for ${p.name}.`)}</Description>`,
    `    <URI>${xmlText(`\\${taskName(p.id)}`)}</URI>`,
    `  </RegistrationInfo>`,
    `  <Triggers>`,
    `    <CalendarTrigger>`,
    `      <StartBoundary>${xmlText(startBoundary(s.time, now))}</StartBoundary>`,
    `      <Enabled>true</Enabled>`,
    `      <ScheduleByWeek>`,
    `        <DaysOfWeek>${days}</DaysOfWeek>`,
    `        <WeeksInterval>1</WeeksInterval>`,
    `      </ScheduleByWeek>`,
    `    </CalendarTrigger>`,
    `  </Triggers>`,
    `  <Principals>`,
    `    <Principal id="Author">`,
    `      <LogonType>InteractiveToken</LogonType>`,
    `      <RunLevel>LeastPrivilege</RunLevel>`,
    `    </Principal>`,
    `  </Principals>`,
    `  <Settings>`,
    `    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>`,
    `    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>`,
    `    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>`,
    `    <AllowHardTerminate>true</AllowHardTerminate>`,
    `    <StartWhenAvailable>true</StartWhenAvailable>`,
    `    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>`,
    `    <IdleSettings>`,
    `      <StopOnIdleEnd>false</StopOnIdleEnd>`,
    `      <RestartOnIdle>false</RestartOnIdle>`,
    `    </IdleSettings>`,
    `    <AllowStartOnDemand>true</AllowStartOnDemand>`,
    `    <Enabled>true</Enabled>`,
    `    <Hidden>false</Hidden>`,
    `    <RunOnlyIfIdle>false</RunOnlyIfIdle>`,
    `    <WakeToRun>${s.wakeToRun === true}</WakeToRun>`,
    `    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>`,
    `    <Priority>7</Priority>`,
    `  </Settings>`,
    `  <Actions Context="Author">`,
    `    <Exec>`,
    `      <Command>${xmlText(exe)}</Command>`,
    `      <Arguments>${xmlText(TASK_ARGUMENTS)}</Arguments>`,
    `    </Exec>`,
    `  </Actions>`,
    `</Task>`,
    ``,
  ].join("\r\n");
}

/**
 * Writes the definition as UTF-16 LE with a byte-order mark (what schtasks /XML reads) to a file in a new
 * private temp folder, hands its path to `use`, and deletes the folder afterwards, whatever happens.
 */
export async function withTaskXmlFile<T>(xml: string, use: (file: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "agent-dock-task-"));
  try {
    const file = path.join(dir, "task.xml");
    await writeFile(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, "utf16le")]), { mode: 0o600 });
    return await use(file);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Creates (or replaces) the project's task from its XML definition. If Task Scheduler refuses it, the
 * old schtasks /SC WEEKLY task is the fallback: same name, action and per-user rights, only default
 * settings, so it is safe. The reason is logged and returned as a note; a failed fallback throws.
 */
export async function createTask(p: Project, exe: string, run: Run = schtasks, log: (message: string) => void = console.warn, now: Date = new Date()): Promise<string | null> {
  try {
    await withTaskXmlFile(taskXml(p, exe, now), (file) => run(createTaskArgs(p, file)));
    return null;
  } catch (error) {
    const reason = (error as Error).message || String(error);
    log(`Task Scheduler refused the task definition for ${p.name} (${reason}); creating it with default settings instead.`);
    await run(legacyTaskArgs(p, exe));
    return `${p.name}: created with Task Scheduler's default settings, so it may not start on battery, catch up a missed start${p.schedule?.wakeToRun ? " or wake the PC" : ""} (${reason}).`;
  }
}

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
  const text = json.replace(/^﻿/, "").trim();
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
 * projects, so each keeps only the tasks that launch its own exe. A task that launches another exe still on
 * disk is the other install's and is left alone; one whose exe is gone is stale and can be taken over.
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
// folder is no tasks; any other failure is an error, so the sync changes nothing.
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
 * Makes Task Scheduler match the projects: creates or updates each wanted task and deletes Agent Dock's
 * other tasks. Only tasks this install owns or stale ones are touched (see taskOwner); another install's
 * tasks are skipped quietly. Returns the problems (an empty list when everything is in place).
 */
export async function syncOsSchedules(projects: Project[], exe: string, run: Run = schtasks, exists: (file: string) => boolean = existsSync, query: () => Promise<string> = queryTasks, log: (message: string) => void = console.warn, now: Date = new Date()): Promise<string[]> {
  const problems: string[] = [];
  const wanted = projects.filter(wantsOsSchedule);
  let existing: OsTask[];
  // Without the current tasks there is no telling whose they are, so nothing is changed.
  try { existing = parseTaskJson(await query()); } catch (error) { return [`Reading the scheduled tasks: ${(error as Error).message}`]; }
  const others = new Set(existing.filter((t) => taskOwner(t, exe, exists) === "other").map((t) => t.name.toLowerCase()));
  for (const p of wanted.filter((x) => !others.has(taskName(x.id).toLowerCase()))) {
    try {
      const note = await createTask(p, exe, run, log, now);
      if (note) problems.push(note);
    } catch (error) { problems.push(`${p.name}: ${(error as Error).message}`); }
  }
  const keep = new Set(wanted.map((p) => taskName(p.id).toLowerCase()));
  for (const { name } of existing.filter((t) => !keep.has(t.name.toLowerCase()) && !others.has(t.name.toLowerCase()))) {
    try { await run(["/Delete", "/F", "/TN", name]); } catch (error) { problems.push(`Removing ${name}: ${(error as Error).message}`); }
  }
  return problems;
}
