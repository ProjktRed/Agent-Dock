import path from "node:path";
import os from "node:os";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, open, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { launchSpec } from "../cmd-line.mjs";
import { HOME_SECRETS } from "../sandbox.mjs";
import { CODEX_WRITE_SANDBOX } from "./adapters/codex.mjs";

/**
 * Guard plan stage 2 for Codex: its sandbox for this run as a permissions profile (Codex's `default_permissions`)
 * in place of the plain `--sandbox` mode. Same writes as before (the workspace; Codex keeps `.git` and `.codex`
 * read-only), no network, and commands can't read your sign-ins, Codex's own home or Agent Dock's data (its state
 * folder holds the run's policy and the decision log's secret). Before it is used, the profile is probed with
 * `codex sandbox` at run start: a write outside the workspace, a read of the state folder and a connection must
 * all fail, and a write inside must work. A Codex without profiles, or a failed probe, falls back to the plain
 * sandbox (as before 0.40), and the attestation says so; with "sandbox agents' commands" on it refuses the run.
 */
export const CODEX_PROFILE = "agent-dock";
const PROBE_MS = 60_000, CACHE_MS = 10 * 60_000;

/**
 * Folders commands must not read: your sign-ins, Codex's home (when moved), Agent Dock's data and the state folder.
 * The app passes its real data folder (AGENT_DOCK_USER_DATA: portable and custom folders too); the usual places are
 * listed as well, for an engine started without it.
 */
export function codexDeniedPaths({ stateDir, home = os.homedir(), env = process.env, platform = process.platform }) {
  const appData = platform === "win32" ? (env.APPDATA ? [path.join(env.APPDATA, "Agent Dock")] : [])
    : platform === "darwin" ? [path.join(home, "Library", "Application Support", "Agent Dock")] : [];
  if (env.XDG_CONFIG_HOME) appData.push(path.join(env.XDG_CONFIG_HOME, "Agent Dock"));
  const listed = [...HOME_SECRETS.map((p) => path.join(home, p)), ...(env.CODEX_HOME ? [env.CODEX_HOME] : []), ...(env.AGENT_DOCK_USER_DATA ? [env.AGENT_DOCK_USER_DATA] : []), ...appData, ...(stateDir ? [stateDir] : [])];
  // Only paths that exist (a rule on a missing path has nothing to protect) and each once.
  return [...new Set(listed.map((p) => path.resolve(p)).filter((p) => existsSync(p)))];
}

/** The -c entries that define and select the profile; `write` extends Codex's workspace profile, else read-only. */
export function codexProfileArgs({ mode = "write", denied = [], writable = [] }) {
  // JSON strings are valid TOML basic strings, so any path (quotes and backslashes included) stays one key.
  // writable: folders a write role also needs (a linked worktree's Git folder), as --add-dir gave the plain sandbox.
  const entries = [...(mode === "write" ? writable.map((p) => [p, "write"]) : []), ...denied.map((p) => [p, "deny"])];
  const filesystem = `{${entries.map(([p, v]) => `${JSON.stringify(path.resolve(p))}="${v}"`).join(",")}}`;
  return ["-c", `permissions.${CODEX_PROFILE}.extends=${JSON.stringify(mode === "write" ? ":workspace" : ":read-only")}`,
    "-c", `permissions.${CODEX_PROFILE}.filesystem=${filesystem}`,
    "-c", `permissions.${CODEX_PROFILE}.network.enabled=false`];
}

// The probe: one line of JSON with each property's result (error codes, never file contents).
const PROBE = `const fs=require("fs"),net=require("net"),r={};
try{fs.writeFileSync("probe.txt","x");r.insideWrite="ok"}catch(e){r.insideWrite=e.code||"error"}
try{fs.writeFileSync(process.argv[1],"x");r.outsideWrite="ok"}catch(e){r.outsideWrite=e.code||"error"}
try{fs.readdirSync(process.argv[2]);r.deniedRead="ok"}catch(e){r.deniedRead=e.code||"error"}
const s=net.connect({host:"example.com",port:443});const done=v=>{r.network=v;s.destroy();console.log(JSON.stringify(r));process.exit(0)};
s.setTimeout(4000,()=>done("timeout"));s.on("connect",()=>done("ok"));s.on("error",e=>done(e.code||"error"));`.replaceAll("\n", "");

/** Runs the probe under the profile. Resolves {ok, results|reason}; `ok` means every property held. */
export async function probeCodexProfile({ mode = "write", launcher, profileArgs, extraArgs = [], stateDir, spawnProcess = spawn, timeoutMs = PROBE_MS }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "adk-codex-probe-")), workspace = path.join(dir, "workspace"), outFile = path.join(dir, "output.txt");
  await mkdir(workspace);
  // Output goes to a file the probe inherits already open: on Linux the sandbox drops writes to Node's socket
  // pipes, and a read-only probe could not create a file of its own.
  const out = await open(outFile, "w");
  try {
    const outside = path.join(stateDir, `sandbox-probe-${randomBytes(6).toString("hex")}`);
    const args = [...(launcher.prefixArgs ?? []), "sandbox", "-P", CODEX_PROFILE, ...profileArgs, ...extraArgs, "-C", workspace, "--", process.execPath, "-e", PROBE, outside, stateDir];
    const launch = launchSpec(launcher.command, args);
    const finished = await new Promise((resolve) => {
      const child = spawnProcess(launch.command, launch.args, { ...launch.options, cwd: workspace, env: launcher.env ?? process.env, windowsHide: true, stdio: ["ignore", out.fd, out.fd] });
      const timer = setTimeout(() => { child.kill(); resolve(false); }, timeoutMs);
      child.on("error", () => { clearTimeout(timer); resolve(false); });
      child.on("close", () => { clearTimeout(timer); resolve(true); });
    });
    const output = finished ? (await readFile(outFile, "utf8").catch(() => "")).slice(0, 64 * 1024) : null;
    // A leftover file means the outside write went through; remove it either way.
    await rm(outside, { force: true }).catch(() => {});
    const line = String(output ?? "").split(/\r?\n/).reverse().find((l) => l.startsWith("{\"insideWrite\""));
    // No result: an old Codex without profiles, or a sandbox that can't enforce them (Windows' unelevated sandbox
    // can't deny reads, and Codex refuses rather than run unconfined). Codex's own last line says which.
    const said = String(output ?? "").trim().split(/\r?\n/).filter(Boolean).at(-1)?.slice(0, 300);
    if (!line) return { ok: false, reason: output === null ? "the probe did not finish" : `Codex could not apply the profile${said ? ` (${said})` : ""}` };
    const results = JSON.parse(line);
    // Read-only roles must not write even inside; write roles must be able to.
    const failed = Object.entries(results).filter(([k, v]) => k === "insideWrite" ? (v === "ok") !== (mode === "write") : v === "ok").map(([k]) => k);
    return failed.length ? { ok: false, results, reason: `the sandbox did not hold: ${failed.join(", ")}` } : { ok: true, results };
  } finally {
    await out.close().catch(() => {});
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

const probes = new Map();
/** Test hook: forget cached probe results. */
export function resetCodexProbes() { probes.clear(); }

/**
 * The sandbox arguments for one Codex invocation and what they were checked to do. `mode` is "write" (Codex's
 * workspace-write: implementation and QA) or "read" (read-only roles). `extraArgs` are the run's own -c entries
 * the sandbox depends on (windows.sandbox). Probe results are reused for ten minutes per CLI and profile.
 */
export async function codexConfinement({ mode = "write", stateDir, launcher = null, extraArgs = [], writable = [], required = false, home, env = process.env, probe = probeCodexProfile }) {
  const plain = mode === "write" ? [...CODEX_WRITE_SANDBOX] : ["--sandbox", "read-only"];
  if (!launcher?.command || !stateDir) return { args: plain, attestation: { sandbox: `codex-${mode === "write" ? "workspace-write" : "read-only"}`, readLimits: false, probe: "not run" } };
  const denied = codexDeniedPaths({ stateDir, home, env });
  const profileArgs = codexProfileArgs({ mode, denied, writable });
  const key = JSON.stringify([launcher.command, launcher.prefixArgs ?? [], profileArgs, extraArgs]);
  let cached = probes.get(key);
  if (!cached || Date.now() - cached.at > CACHE_MS) {
    cached = { at: Date.now(), result: await probe({ mode, launcher, profileArgs, extraArgs, stateDir }).catch((error) => ({ ok: false, reason: error.message })) };
    // Only a passing probe is reused: a failure is checked again next time (a CLI update may fix it).
    if (cached.result.ok) probes.set(key, cached); else probes.delete(key);
  }
  const { ok, results, reason } = cached.result;
  if (ok) return { args: ["-c", `default_permissions="${CODEX_PROFILE}"`, ...profileArgs, "-c", 'approval_policy="never"'], attestation: { sandbox: `codex-profile-${mode}`, readLimits: true, denied: denied.length, probe: "passed", results } };
  // Sandboxing required: a probe that saw the sandbox let something through refuses the run; a Codex without
  // profiles keeps its plain sandbox, as before 0.40.
  if (required && results) throw new Error(`Agent Dock is set to sandbox agents' commands (Settings › Experimental), but Codex's sandbox could not be confirmed: ${reason}`);
  return { args: plain, attestation: { sandbox: `codex-${mode === "write" ? "workspace-write" : "read-only"}`, readLimits: false, probe: "failed", reason, ...(results ? { results } : {}) } };
}
