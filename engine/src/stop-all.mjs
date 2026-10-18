import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { DashboardState, flushActionLog } from "./dashboard-state.mjs";

// Stop-all from a terminal, without the app: every project's engine stops at its next safe point,
// or at once with --now. The app writes a launcher (stop-all.cmd / stop-all.sh) into its config
// folder. Authentication is the OS account plus the guard: that folder and every project's state
// folder are protected paths, so workers can neither read the project list nor write control files.
const exec = promisify(execFile);

export function parseStopArgs(argv) {
  const options = { config: process.env.AGENT_DOCK_CONFIG ?? null, now: false, project: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--now") options.now = true;
    else if (arg === "--config" || arg === "--project") { if (!argv[i + 1]) throw new Error(`${arg} needs a value`); options[arg.slice(2)] = argv[++i]; }
    else throw new Error(`Unknown option ${arg}`);
  }
  if (!options.config) throw new Error("Pass --config <Agent Dock config folder> (or use the stop-all launcher in that folder)");
  return options;
}

/** The engine's PID, only while that PID is still a node/Electron process (not one reused after a reboot). */
async function enginePid(stateDir) {
  let record;
  try { record = JSON.parse(await readFile(path.join(stateDir, "app-engine.json"), "utf8")); } catch { return null; }
  if (!Number.isInteger(record?.pid) || record.pid <= 0) return null;
  try { process.kill(record.pid, 0); } catch { return null; }
  if (process.platform === "win32") {
    const { stdout } = await exec("tasklist", ["/FI", `PID eq ${record.pid}`, "/FO", "CSV", "/NH"], { windowsHide: true, timeout: 5000 }).catch(() => ({ stdout: "" }));
    return /node|electron|agent dock/i.test(stdout) ? record.pid : null;
  }
  const cmd = await readFile(`/proc/${record.pid}/cmdline`, "utf8").catch(() => "node");
  return /node|electron|agent.dock/i.test(cmd) ? record.pid : null;
}

async function killTree(pid) {
  if (process.platform === "win32") await exec("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 10_000 });
  else { try { process.kill(-pid, "SIGKILL"); } catch { process.kill(pid, "SIGKILL"); } }
}

/** Stops every running project (or the one named by --project); returns one line per project. */
export async function stopAll({ config, now = false, project = null }, { kill = killTree, findPid = enginePid } = {}) {
  const projects = JSON.parse(await readFile(path.join(config, "projects.json"), "utf8"));
  const chosen = projects.filter((p) => p?.stateDir && (!project || p.id === project || p.name === project));
  if (project && !chosen.length) throw new Error(`No project named ${project}`);
  const results = [];
  for (const p of chosen) {
    const pid = await findPid(p.stateDir);
    if (!pid) { results.push({ project: p.name, result: "not running" }); continue; }
    const state = new DashboardState({ stateDir: p.stateDir });
    if (now) {
      await kill(pid);
      // The killed engine writes nothing; record the stop so it is not taken for an interruption.
      await state.record({ type: "stopped", reason: "stop-now", source: "cli" });
      results.push({ project: p.name, result: "stopped now" });
    } else {
      await state.setControl("stop", { source: "cli" });
      results.push({ project: p.name, result: "stopping at the next safe point" });
    }
  }
  await flushActionLog();
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const results = await stopAll(parseStopArgs(process.argv.slice(2)));
    for (const r of results) console.log(`${r.project}: ${r.result}`);
    if (!results.length) console.log("No projects.");
  } catch (error) {
    console.error(`Stop-all failed: ${error.message}`);
    process.exitCode = 1;
  }
}
