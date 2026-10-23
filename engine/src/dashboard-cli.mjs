import { spawn } from "node:child_process";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { startDashboardServer } from "./dashboard-server.mjs";
import { DashboardState } from "./dashboard-state.mjs";
import { diagnostic, installTopLevelDiagnostics } from "./diagnostics.mjs";
import { openDashboard } from "./open-dashboard.mjs";

installTopLevelDiagnostics();
// Git reads by the engine and every process it starts skip optional locks (a status refresh of the index),
// so they never hold index.lock while QA commits.
process.env.GIT_OPTIONAL_LOCKS = "0";

const argv = process.argv.slice(2);
const forwarded = [];
let port = 4173;
for (let index = 0; index < argv.length; index += 2) {
  const key = argv[index];
  const value = argv[index + 1];
  if (!key?.startsWith("--") || value === undefined) {
    throw new Error(`Expected --name value, received: ${key ?? "<end>"}`);
  }
  if (key === "--port") port = Number(value);
  else forwarded.push(key, value);
}

const valueAfter = (name, fallback) => {
  const index = forwarded.indexOf(name);
  return index >= 0 ? forwarded[index + 1] : fallback;
};
const root = process.cwd();
const workspace = path.resolve(root, valueAfter("--workspace", "."));
const stateDir = path.resolve(root, valueAfter("--state-dir", ".state"));
const sourceDir = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.join(sourceDir, "cli.mjs");
const elevatePath = path.join(sourceDir, "elevate-cli.mjs");
const dashboardState = new DashboardState({ stateDir });
let automation = null;
let elevateWorker = null;

function spawnElevate() {
  if (elevateWorker) return;
  elevateWorker = spawn(process.execPath, [elevatePath, ...forwarded], { cwd: root, windowsHide: true, stdio: "inherit" });
  elevateWorker.on("error", (error) => {
    console.error(error);
    void dashboardState.record({ type: "elevate-launch-failed", qa: error.message });
  });
  elevateWorker.on("close", (exitCode) => {
    console.log(`Elevate exited with code ${exitCode ?? 1}; dashboard remains available.`);
    elevateWorker = null;
  });
}

function requestElevate() {
  if (elevateWorker) return;
  if (automation) return; // The live loop consumes the durable control request.
  else spawnElevate();
}

function spawnAutomation(resolveBlock=false) {
  automation = spawn(process.execPath, [cliPath, ...forwarded, ...(resolveBlock?['--resolve-block','true']:[])], { cwd: root, windowsHide: true, stdio: "inherit" });
  automation.on("error", (error) => console.error(error));
  automation.on("close", (exitCode) => {
    console.log(`Automation exited with code ${exitCode ?? 1}; dashboard remains available.`);
    diagnostic("DASHBOARD_SERVER_ALIVE", { url: dashboard.url, automationExitCode: exitCode ?? 1 });
    automation = null;
  });
}

const dashboard = await startDashboardServer({
  stateDir, workspace, port,
  onControl: async (action) => {
    if (action === "elevate") requestElevate();
    if (action === "resolve" && !automation && !elevateWorker) spawnAutomation(true);
    if (action === "resume" && !automation && !elevateWorker) spawnAutomation();
  },
});
console.log(`Dashboard: ${dashboard.url} (authenticated link opened in your browser)`);
openDashboard(dashboard.launchUrl, { launchDir: stateDir });

let pending = null;
try { pending = JSON.parse(await readFile(path.join(stateDir, "pending-codex.json"), "utf8")); }
catch (error) { if (error.code !== "ENOENT") throw error; }
spawnAutomation();
