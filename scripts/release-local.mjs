#!/usr/bin/env node
// Builds the Windows app from a clean copy of a committed version and installs it.
//
// Used two ways:
//   1. First install, from the source repo:   npm run release:local
//   2. By the installed app's updater, in two stages:
//        --stage build  (app keeps running and shows the log)
//        --stage swap   (after the app exits: replace files, relaunch)
//
// The source can be a local repository path today and a GitHub URL later; both work with git.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logoPng } from "./logo.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const LOCAL = process.env.LOCALAPPDATA ?? path.join(process.env.USERPROFILE ?? "C:\\", "AppData", "Local");
// Installed app and its update workspace live side by side, outside the source repository:
//   <root>\App      the installed app (AgentDock.exe)
//   <root>\Updates  clean clone of the committed source + build output
// <root> is %LOCALAPPDATA%\Programs\Agent Dock, or AGENT_DOCK_HOME when set.
const ROOT = process.env.AGENT_DOCK_HOME ?? path.join(LOCAL, "Programs", "Agent Dock");
export const DEFAULTS = {
  staging: path.join(ROOT, "Updates"),
  installDir: path.join(ROOT, "App"),
  exeName: "AgentDock.exe",
  shortcutName: "Agent Dock",
};

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`Unexpected argument: ${a}`);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[a.slice(2)] = true;
    else {
      out[a.slice(2)] = next;
      i++;
    }
  }
  return out;
}

const log = (msg) => console.log(`[release] ${msg}`);

function run(cmd, args, opts = {}) {
  log(`$ ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { stdio: opts.capture ? ["ignore", "pipe", "pipe"] : "inherit", shell: opts.shell ?? false, cwd: opts.cwd, windowsHide: true, encoding: "utf8", env: { ...process.env, ...(opts.env ?? {}) } });
  if (r.error) throw r.error;
  if (r.status !== 0 && !opts.allowFail) throw new Error(`${cmd} ${args.join(" ")} exited with ${r.status}${opts.capture ? `: ${r.stderr}` : ""}`);
  return r;
}
const git = (args, cwd, capture = true) => run("git", args, { cwd, capture }).stdout?.trim() ?? "";

/** Clone or refresh the staging copy and check out the requested committed version. */
export function prepareStaging({ source, branch, commit, staging }) {
  const repo = path.join(staging, "repo");
  mkdirSync(staging, { recursive: true });
  if (!existsSync(path.join(repo, ".git"))) run("git", ["clone", "--no-checkout", source, repo]);
  else run("git", ["remote", "set-url", "origin", source], { cwd: repo });
  run("git", ["fetch", "--force", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`], { cwd: repo });
  const target = commit ?? git(["rev-parse", `origin/${branch}`], repo);
  run("git", ["checkout", "--force", "--detach", target], { cwd: repo });
  // Committed files only: remove anything else, but keep node_modules to speed up rebuilds.
  run("git", ["clean", "-ffdx", "-e", "node_modules"], { cwd: repo });
  return { repo, target };
}

/**
 * electron-builder's winCodeSign archive contains macOS symlinks that Windows cannot create
 * without Developer Mode, so its own extraction fails. The Windows tools are unaffected:
 * extract them ourselves (ignoring the symlink errors) into the folder electron-builder reuses.
 */
function prepareWinCodeSign(repo) {
  const cache = path.join(LOCAL, "electron-builder", "Cache", "winCodeSign");
  const target = path.join(cache, "winCodeSign-2.6.0");
  if (existsSync(path.join(target, "rcedit-x64.exe"))) return false;
  const archive = existsSync(cache) ? readdirSync(cache).find((f) => f.endsWith(".7z")) : null;
  if (!archive) return false;
  const sevenZip = path.join(repo, "node_modules", "7zip-bin", "win", "x64", "7za.exe");
  log(`extracting ${archive} into ${target} (macOS symlinks skipped)`);
  run(sevenZip, ["x", "-bd", "-y", path.join(cache, archive), `-o${target}`], { capture: true, allowFail: true });
  return existsSync(path.join(target, "rcedit-x64.exe"));
}

/** npm ci → electron-vite build → electron-builder --dir, inside the staging copy. */
export function buildStaging({ repo, source, branch, staging }) {
  const commit = git(["rev-parse", "HEAD"], repo);
  const info = {
    commit,
    shortCommit: commit.slice(0, 7),
    subject: git(["log", "-1", "--format=%s"], repo),
    committedAt: git(["log", "-1", "--format=%cI"], repo),
    branch,
    source,
    builtAt: new Date().toISOString(),
  };
  writeFileSync(path.join(repo, "build-info.json"), `${JSON.stringify(info, null, 2)}\n`);
  mkdirSync(path.join(repo, "build"), { recursive: true });
  writeFileSync(path.join(repo, "build", "icon.png"), logoPng(256));
  run("npm", ["ci", "--no-audit", "--no-fund"], { cwd: repo, shell: true });
  run("npx", ["electron-vite", "build"], { cwd: repo, shell: true });
  const out = path.join(staging, "dist");
  const builder = () => run("npx", ["electron-builder", "--win", "--dir", `--config.directories.output="${out}"`], { cwd: repo, shell: true, env: { CSC_IDENTITY_AUTO_DISCOVERY: "false" } });
  try {
    builder();
  } catch (error) {
    if (!prepareWinCodeSign(repo)) throw error;
    log("retrying electron-builder with the prepared winCodeSign cache");
    builder();
  }
  const unpacked = path.join(out, "win-unpacked");
  if (!existsSync(path.join(unpacked, DEFAULTS.exeName))) throw new Error(`Build finished but ${DEFAULTS.exeName} was not found in ${unpacked}`);
  log(`built ${info.shortCommit} "${info.subject}" → ${unpacked}`);
  console.log(`RESULT ${JSON.stringify({ ok: true, unpacked, ...info })}`);
  return { unpacked, info };
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function shortcut(target, linkPath) {
  const ps = `$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${linkPath.replaceAll("'", "''")}');$s.TargetPath='${target.replaceAll("'", "''")}';$s.WorkingDirectory='${path.dirname(target).replaceAll("'", "''")}';$s.Save()`;
  run("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { allowFail: true });
}

/** Replace the installed files with a fresh build (robocopy /MIR), add shortcuts, optionally relaunch. */
export async function swap({ from, installDir, waitPid, relaunch, shortcuts = true }) {
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
  const r = run("robocopy", [from, fresh, "/MIR", "/R:2", "/W:1", "/NFL", "/NDL", "/NJH", "/NP"], { allowFail: true });
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
      throw new Error(`${installDir} is in use (close every Agent Dock window and stop running automation). The installed version was left unchanged.`);
    }
  }
  try {
    renameSync(fresh, installDir);
  } catch (error) {
    if (existsSync(old)) renameSync(old, installDir);
    throw error;
  }
  if (existsSync(old)) rmSync(old, { recursive: true, force: true });
  const exe = path.join(installDir, DEFAULTS.exeName);
  if (shortcuts) {
    const startMenu = path.join(process.env.APPDATA ?? "", "Microsoft", "Windows", "Start Menu", "Programs", `${DEFAULTS.shortcutName}.lnk`);
    const desktop = path.join(process.env.USERPROFILE ?? "", "Desktop", `${DEFAULTS.shortcutName}.lnk`);
    // Only create missing shortcuts: updates keep the same install path, so existing ones stay valid.
    if (!existsSync(startMenu)) shortcut(exe, startMenu);
    if (!existsSync(desktop)) shortcut(exe, desktop);
  }
  log(`installed to ${installDir}`);
  if (relaunch) spawn(exe, [], { detached: true, stdio: "ignore" }).unref();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const stage = args.stage ?? "all";
  const source = args.source ?? path.resolve(here, "..");
  const branch = args.branch ?? (existsSync(source) ? git(["rev-parse", "--abbrev-ref", "HEAD"], source) : "master");
  const staging = args.staging ?? DEFAULTS.staging;
  const installDir = args["install-dir"] ?? DEFAULTS.installDir;

  if (stage === "build" || stage === "all") {
    const prepared = args["skip-checkout"] ? { repo: path.join(staging, "repo") } : prepareStaging({ source, branch, commit: args.commit, staging });
    const { unpacked } = buildStaging({ repo: prepared.repo, source, branch, staging });
    if (stage === "all") await swap({ from: unpacked, installDir, relaunch: Boolean(args.launch) });
  } else if (stage === "swap") {
    // Record the outcome for the app to show on its next launch, and always relaunch it, so a
    // failed swap never leaves the user with no app and no explanation.
    const resultFile = path.join(path.dirname(installDir), "Updates", "last-swap.json");
    try {
      await swap({ from: args.from ?? path.join(staging, "dist", "win-unpacked"), installDir, waitPid: args["wait-pid"], relaunch: Boolean(args.relaunch) });
      writeFileSync(resultFile, JSON.stringify({ ok: true, at: new Date().toISOString() }));
    } catch (error) {
      writeFileSync(resultFile, JSON.stringify({ ok: false, error: error.message, at: new Date().toISOString() }));
      const exe = path.join(installDir, DEFAULTS.exeName);
      if (args.relaunch && existsSync(exe)) spawn(exe, [], { detached: true, stdio: "ignore" }).unref();
      throw error;
    }
  } else throw new Error(`Unknown --stage ${stage}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[release] FAILED: ${error.message}`);
    process.exit(1);
  });
}
