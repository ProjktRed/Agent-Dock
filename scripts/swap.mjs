// Replaces the installed app with a new build, after the running app has exited, then relaunches it.
// Shipped inside the app (resources/scripts/swap.mjs) so a signed release can be installed without
// Node.js on PATH: the downloaded app's own executable runs it with ELECTRON_RUN_AS_NODE=1, from the
// staging folder, outside the folder being replaced.
//
//   swap.mjs --from <new win-unpacked> --install-dir <App> [--wait-pid N] [--relaunch] [--result <json>]
import { spawn, spawnSync } from "node:child_process";
import { existsSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const EXE_NAME = "AgentDock.exe";
export const SHORTCUT_NAME = "Agent Dock";
const log = (msg) => console.log(`[swap] ${msg}`);

function run(cmd, args) {
  log(`$ ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { stdio: "inherit", windowsHide: true, encoding: "utf8" });
  if (r.error) throw r.error;
  return r;
}

/** The relaunched app must not inherit Node mode from the swap process. */
function appEnv() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function shortcut(target, linkPath) {
  const ps = `$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${linkPath.replaceAll("'", "''")}');$s.TargetPath='${target.replaceAll("'", "''")}';$s.WorkingDirectory='${path.dirname(target).replaceAll("'", "''")}';$s.Save()`;
  spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { windowsHide: true });
}

/** Replace the installed files with a fresh build (robocopy /MIR), add shortcuts, optionally relaunch. */
export async function swap({ from, installDir, waitPid, relaunch, shortcuts = true }) {
  if (!existsSync(path.join(from, EXE_NAME))) throw new Error(`${from} does not contain ${EXE_NAME}`);
  if (waitPid) {
    log(`waiting for app process ${waitPid} to exit…`);
    for (let i = 0; i < 600 && pidAlive(Number(waitPid)); i++) await new Promise((r) => setTimeout(r, 500));
    if (pidAlive(Number(waitPid))) throw new Error("The app did not exit; update not applied.");
    await new Promise((r) => setTimeout(r, 1000));
  }
  // All-or-nothing: copy beside the install, then swap folders by rename. Windows refuses to
  // rename a folder while any file in it is in use (another Agent Dock window, an engine whose
  // working directory is inside it), so a busy install is left untouched instead of half-copied.
  const fresh = `${installDir}.new`;
  const old = `${installDir}.old`;
  for (const stale of [fresh, old]) if (existsSync(stale)) rmSync(stale, { recursive: true, force: true });
  const r = run("robocopy", [from, fresh, "/MIR", "/R:2", "/W:1", "/NFL", "/NDL", "/NJH", "/NP"]);
  // robocopy: 0–7 are success codes, 8+ are failures.
  if (r.status >= 8) throw new Error(`robocopy into ${fresh} failed with exit code ${r.status}`);
  if (existsSync(installDir)) {
    let moved = false;
    for (let i = 0; i < 20 && !moved; i++) {
      try {
        renameSync(installDir, old);
        moved = true;
      } catch {
        await new Promise((res) => setTimeout(res, 1500));
      }
    }
    if (!moved) {
      rmSync(fresh, { recursive: true, force: true });
      throw new Error(`${installDir} is in use: another Agent Dock window, running automation, or a program started from it (such as a llama.cpp server started by an older version) still works inside that folder. Close it and update again. The installed version was left unchanged.`);
    }
  }
  try {
    renameSync(fresh, installDir);
  } catch (error) {
    if (existsSync(old)) renameSync(old, installDir);
    throw error;
  }
  if (existsSync(old)) rmSync(old, { recursive: true, force: true });
  const exe = path.join(installDir, EXE_NAME);
  if (shortcuts) {
    const startMenu = path.join(process.env.APPDATA ?? "", "Microsoft", "Windows", "Start Menu", "Programs", `${SHORTCUT_NAME}.lnk`);
    const desktop = path.join(process.env.USERPROFILE ?? "", "Desktop", `${SHORTCUT_NAME}.lnk`);
    // Only create missing shortcuts: updates keep the same install path, so existing ones stay valid.
    if (!existsSync(startMenu)) shortcut(exe, startMenu);
    if (!existsSync(desktop)) shortcut(exe, desktop);
  }
  log(`installed to ${installDir}`);
  if (relaunch) spawn(exe, [], { detached: true, stdio: "ignore", env: appEnv() }).unref();
}

/**
 * The swap stage as the updater runs it: record the outcome for the app to show on its next launch,
 * and always relaunch, so a failed swap never leaves the user with no app and no explanation.
 */
export async function swapStage({ from, installDir, waitPid, relaunch, result }) {
  try {
    await swap({ from, installDir, waitPid, relaunch });
    if (result) writeFileSync(result, JSON.stringify({ ok: true, at: new Date().toISOString() }));
  } catch (error) {
    if (result) writeFileSync(result, JSON.stringify({ ok: false, error: error.message, at: new Date().toISOString() }));
    const exe = path.join(installDir, EXE_NAME);
    if (relaunch && existsSync(exe)) spawn(exe, [], { detached: true, stdio: "ignore", env: appEnv() }).unref();
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, ""), next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) args[key] = true;
    else { args[key] = next; i++; }
  }
  if (!args.from || !args["install-dir"]) { console.error("usage: swap.mjs --from <dir> --install-dir <dir> [--wait-pid N] [--relaunch] [--result <json>]"); process.exit(2); }
  swapStage({ from: args.from, installDir: args["install-dir"], waitPid: args["wait-pid"], relaunch: Boolean(args.relaunch), result: typeof args.result === "string" ? args.result : null })
    .catch((error) => { console.error(`[swap] ${error.message}`); process.exitCode = 1; });
}
