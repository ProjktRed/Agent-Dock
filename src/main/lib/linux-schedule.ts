import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Scheduled runs happen only while Agent Dock is open (from 0.39). Version 0.38 could also put a project's
// schedule in a systemd user timer in ~/.config/systemd/user that launched the AppImage with --scheduled-run.
// This removes those timers once, on the first launch after the upgrade, as on Windows.

const PREFIX = "agent-dock-run-";

export const unitName = (projectId: string) => `${PREFIX}${projectId.replace(/[^\w-]/g, "_")}`;
export const userUnitDir = (home = os.homedir(), env: NodeJS.ProcessEnv = process.env) => path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "systemd", "user");

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
 * Disables and deletes the scheduled-run timers an earlier version made. A timer whose service starts
 * another existing Agent Dock (another copy of the AppImage) is left alone. Returns the problems.
 */
export async function removeLinuxSchedules(exe: string, { dir = userUnitDir(), run = systemctl, exists = existsSync }: { dir?: string; run?: Systemctl; exists?: (file: string) => boolean } = {}): Promise<string[]> {
  const names = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.startsWith(PREFIX) && f.endsWith(".timer")).map((f) => f.slice(0, -6));
  const remove: string[] = [];
  for (const name of names) {
    const other = serviceExe(await readFile(path.join(dir, `${name}.service`), "utf8").catch(() => ""));
    if (!(other && other !== exe && exists(other))) remove.push(name);
  }
  if (!remove.length) return [];
  try {
    for (const name of remove) await run(["disable", "--now", `${name}.timer`]).catch(() => "");
    for (const name of remove) for (const ext of [".timer", ".service"]) await rm(path.join(dir, name + ext), { force: true });
    await run(["daemon-reload"]);
  } catch (error) { return [`systemd: ${(error as Error).message}`]; }
  return [];
}
