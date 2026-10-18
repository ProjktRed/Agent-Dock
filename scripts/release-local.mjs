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
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logoPng } from "./logo.mjs";
import { swap, swapStage } from "./swap.mjs";
export { swap };

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
  mkdirSync(path.join(repo, "build"), { recursive: true });
  writeFileSync(path.join(repo, "build", "icon.png"), logoPng(256));
  run("npm", ["ci", "--no-audit", "--no-fund"], { cwd: repo, shell: true });
  run("npx", ["electron-vite", "build"], { cwd: repo, shell: true, env: { AGENT_DOCK_BUILD_SOURCE: source, AGENT_DOCK_BUILD_BRANCH: branch } });
  const info = JSON.parse(readFileSync(path.join(repo, "build-info.json"), "utf8"));
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
    await swapStage({ from: args.from ?? path.join(staging, "dist", "win-unpacked"), installDir, waitPid: args["wait-pid"], relaunch: Boolean(args.relaunch), result: path.join(path.dirname(installDir), "Updates", "last-swap.json") });
  } else throw new Error(`Unknown --stage ${stage}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[release] FAILED: ${error.message}`);
    process.exit(1);
  });
}
