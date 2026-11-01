import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

// engine-pid.json: the engine's own process id, as its operating system sees it. The app's record
// (app-engine.json) holds the process it started, which under WSL isolation is wsl.exe on Windows;
// Stop now needs this one to end the engine and its CLIs inside the distro as well.
export const ENGINE_PID_FILE = "engine-pid.json";

export function writeEnginePid(stateDir, now = new Date()) {
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(path.join(stateDir, ENGINE_PID_FILE), JSON.stringify({ pid: process.pid, platform: process.platform, startedAt: now.toISOString() }));
  } catch { /* Stop now falls back to ending the process the app started */ }
}
