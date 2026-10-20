import { execFile } from "node:child_process";
import type { Project } from "@shared/types";
import { scheduleMinutes } from "@shared/schedule";

// Scheduled runs while Agent Dock is closed (0.35, Windows). A project's schedule can also be put in
// Windows Task Scheduler as a per-user task under "\Agent Dock\" that launches Agent Dock minimized with
// --scheduled-run at the scheduled time. The app then starts every project whose slot is due, exactly as
// its own once-a-minute check does, so a run never starts twice. No admin rights or service: the task
// runs only while you are signed in, as you.

export const TASK_FOLDER = "Agent Dock";
export const SCHEDULED_RUN_FLAG = "--scheduled-run";
const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

export const taskName = (projectId: string) => `${TASK_FOLDER}\\Run ${projectId.replace(/[^\w-]/g, "_")}`;

/** Projects whose schedule should exist in Task Scheduler. */
export function wantsOsSchedule(p: Project): boolean {
  return !p.archived && p.schedule?.enabled === true && p.schedule.whenClosed === true && p.schedule.days?.length > 0 && scheduleMinutes(p.schedule.time) !== null;
}

/** schtasks arguments that create (or replace) the project's weekly task. */
export function createTaskArgs(p: Project, exe: string): string[] {
  const days = [...new Set(p.schedule!.days)].sort().map((d) => DAYS[d]).join(",");
  return ["/Create", "/F", "/TN", taskName(p.id), "/SC", "WEEKLY", "/D", days, "/ST", p.schedule!.time, "/TR", `"${exe}" --minimized ${SCHEDULED_RUN_FLAG}`];
}

/** Task names under \Agent Dock\ in `schtasks /Query /FO CSV /NH` output, without the leading backslash. */
export function parseTaskList(csv: string): string[] {
  const names = new Set<string>();
  for (const line of csv.split(/\r?\n/)) {
    const name = /^"([^"]+)"/.exec(line.trim())?.[1];
    if (name?.toLowerCase().startsWith(`\\${TASK_FOLDER.toLowerCase()}\\`)) names.add(name.slice(1));
  }
  return [...names];
}

type Run = (args: string[]) => Promise<string>;
const schtasks: Run = (args) => new Promise((resolve, reject) => {
  execFile("schtasks.exe", args, { windowsHide: true, timeout: 20_000 }, (error, stdout, stderr) => (error ? reject(new Error(String(stderr || error.message).trim())) : resolve(stdout)));
});

/**
 * Makes Task Scheduler match the projects: creates or updates each wanted task and deletes Agent Dock's
 * other tasks. Returns the problems (an empty list when everything is in place).
 */
export async function syncOsSchedules(projects: Project[], exe: string, run: Run = schtasks): Promise<string[]> {
  const problems: string[] = [];
  const wanted = projects.filter(wantsOsSchedule);
  let existing: string[] = [];
  try { existing = parseTaskList(await run(["/Query", "/FO", "CSV", "/NH"])); } catch { existing = []; }
  for (const p of wanted) {
    try { await run(createTaskArgs(p, exe)); } catch (error) { problems.push(`${p.name}: ${(error as Error).message}`); }
  }
  const keep = new Set(wanted.map((p) => taskName(p.id).toLowerCase()));
  for (const name of existing.filter((n) => !keep.has(n.toLowerCase()))) {
    try { await run(["/Delete", "/F", "/TN", name]); } catch (error) { problems.push(`Removing ${name}: ${(error as Error).message}`); }
  }
  return problems;
}
