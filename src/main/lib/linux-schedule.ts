import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Project } from "@shared/types";
import { SCHEDULED_RUN_FLAG, wantsOsSchedule } from "./os-schedule";

// Scheduled runs while Agent Dock is closed, on Linux (0.38): a systemd user timer per project in
// ~/.config/systemd/user that launches the AppImage minimized with --scheduled-run at the scheduled time.
// The app then starts every project whose slot is due, as on Windows. No root: the timer belongs to you
// and runs while you are signed in. Persistent=true runs a start missed while the PC was off at the next
// login, and the app reports it as missed when it is past the grace period.

const PREFIX = "agent-dock-run-";
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** The graphical session the app needs; captured at each sync, which runs at every launch. */
const SESSION_VARS = ["DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"];

export const unitName = (projectId: string) => `${PREFIX}${projectId.replace(/[^\w-]/g, "_")}`;
export const userUnitDir = (home = os.homedir(), env: NodeJS.ProcessEnv = process.env) => path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "systemd", "user");

/** A value inside a systemd unit: specifiers (%) and variables ($) taken literally, quoted. */
export function unitQuote(value: string): string {
  if (/[\0\r\n]/.test(value)) throw new Error("A path in a systemd unit cannot contain line breaks.");
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\$/g, "$$$$")}"`;
}

export function timerUnit(p: Project): string {
  const days = [...new Set(p.schedule!.days)].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort().map((d) => DAYS[d]).join(",");
  return [
    `# Agent Dock: scheduled run for one project (${p.id}). Turn off "Also when closed" in Agent Dock to remove it.`,
    "[Unit]", `Description=Agent Dock scheduled run`, "",
    "[Timer]", `OnCalendar=${days} *-*-* ${p.schedule!.time}:00`, "Persistent=true", "AccuracySec=1min", `Unit=${unitName(p.id)}.service`, "",
    "[Install]", "WantedBy=timers.target", "",
  ].join("\n");
}

export function serviceUnit(p: Project, exe: string, env: NodeJS.ProcessEnv = process.env): string {
  const session = SESSION_VARS.filter((k) => env[k] && !/[\0\r\n]/.test(env[k]!)).map((k) => `Environment=${unitQuote(`${k}=${env[k]}`)}`);
  return [
    `# Agent Dock: launches Agent Dock for a scheduled run (${p.id}).`,
    "[Unit]", "Description=Agent Dock scheduled run", "",
    "[Service]", "Type=exec", ...session, `ExecStart=${unitQuote(exe)} --minimized ${SCHEDULED_RUN_FLAG}`, "",
  ].join("\n");
}

/** The program a service unit of ours starts, or null. */
export function serviceExe(text: string): string | null {
  const m = /^ExecStart="((?:[^"\\]|\\.)*)"/m.exec(text);
  return m ? m[1].replace(/\\(.)/g, "$1").replace(/%%/g, "%").replace(/\$\$/g, "$") : null;
}

export type Systemctl = (args: string[]) => Promise<string>;
const systemctl: Systemctl = (args) => new Promise((resolve, reject) => {
  execFile("systemctl", ["--user", ...args], { timeout: 20_000 }, (error, stdout, stderr) => (error ? reject(new Error(String(stderr || error.message).trim())) : resolve(stdout)));
});

/**
 * Makes the user timers match the projects, like syncOsSchedules on Windows: writes and enables each
 * wanted timer, removes Agent Dock's other ones. A timer whose service starts another existing Agent Dock
 * (another copy of the AppImage) is left alone. Returns the problems (empty when all is in place).
 */
export async function syncLinuxSchedules(projects: Project[], exe: string, { dir = userUnitDir(), run = systemctl, env = process.env, exists = existsSync }: { dir?: string; run?: Systemctl; env?: NodeJS.ProcessEnv; exists?: (file: string) => boolean } = {}): Promise<string[]> {
  const problems: string[] = [];
  const wanted = projects.filter(wantsOsSchedule);
  const names = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.startsWith(PREFIX) && f.endsWith(".timer")).map((f) => f.slice(0, -6));
  const owner = async (name: string) => {
    const other = serviceExe(await readFile(path.join(dir, `${name}.service`), "utf8").catch(() => ""));
    return other && other !== exe && exists(other) ? "other" : "mine";
  };
  const others = new Set<string>();
  for (const name of names) if ((await owner(name)) === "other") others.add(name);
  const changed: string[] = [];
  await mkdir(dir, { recursive: true });
  for (const p of wanted.filter((x) => !others.has(unitName(x.id)))) {
    try {
      const name = unitName(p.id);
      for (const [file, text] of [[`${name}.timer`, timerUnit(p)], [`${name}.service`, serviceUnit(p, exe, env)]] as const) {
        if ((await readFile(path.join(dir, file), "utf8").catch(() => null)) !== text) { await writeFile(path.join(dir, file), text); changed.push(name); }
      }
    } catch (error) { problems.push(`${p.name}: ${(error as Error).message}`); }
  }
  const keep = new Set(wanted.map((p) => unitName(p.id)));
  const remove = names.filter((n) => !keep.has(n) && !others.has(n));
  try {
    for (const name of remove) await run(["disable", "--now", `${name}.timer`]).catch(() => "");
    for (const name of remove) for (const ext of [".timer", ".service"]) await rm(path.join(dir, name + ext), { force: true });
    if (changed.length || remove.length) await run(["daemon-reload"]);
    for (const p of wanted.filter((x) => !others.has(unitName(x.id)))) await run(["enable", "--now", `${unitName(p.id)}.timer`]);
  } catch (error) { problems.push(`systemd: ${(error as Error).message}`); }
  return problems;
}
