import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { checkEnv } from "./secret-env.mjs";

/**
 * Experimental, off unless Settings › Experimental turns it on (--sandbox-checks true): project checks run
 * inside Anthropic's sandbox runtime (@anthropic-ai/sandbox-runtime, "srt") instead of as you. A check then
 * writes only its worktree (never Git's own folder), has no network, and cannot open your home folder: on
 * Windows it runs as a separate local account (srt-sandbox) that has no rights on your profile, so it cannot
 * read or decrypt Agent Dock's saved keys or your CLI sign-ins; on Linux bubblewrap hides your home folder
 * except the worktree and the toolchain. A sandbox that cannot start fails the check: a check never falls
 * back to running as you.
 */
let enabled = false;
export function useSandboxedChecks(value) { enabled = value === true; }
export const checksSandboxed = () => enabled;

/**
 * Experimental too (--sandbox-agents true): Codex's and Claude Code's own shell commands run sandboxed
 * (install-protection.mjs adds it to every call). Claude Code uses the same sandbox runtime as checks.
 */
let agents = false;
export function useSandboxedAgents(value) { agents = value === true; }
export const agentsSandboxed = () => agents;

// Sign-ins and keys under your home folder. Linux hides the whole home folder already; these stay hidden
// even when the worktree or a toolchain folder beneath home is let back in. (Windows needs no list: the
// sandbox account cannot open your profile at all.)
export const HOME_SECRETS = [".ssh", ".aws", ".azure", ".gnupg", ".docker", ".kube", ".codex", ".claude", ".config/gh", ".config/gcloud", ".config/Agent Dock", ".local/share/keyrings", ".npmrc", ".git-credentials", ".netrc", ".pypirc"];

const inside = (parent, child) => {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

/**
 * Install folders of the Node and Git a check finds on PATH, when they sit under your home folder (nvm,
 * per-user installs): the sandbox would hide them otherwise. Machine-wide installs need no entry.
 */
export function toolchainDirs({ env = process.env, home = os.homedir(), platform = process.platform } = {}) {
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH");
  const dirs = String((pathKey && env[pathKey]) ?? "").split(platform === "win32" ? ";" : ":").filter(Boolean);
  const found = [];
  for (const tool of ["node", "git"]) {
    const name = platform === "win32" ? `${tool}.exe` : tool;
    const dir = dirs.find((d) => existsSync(path.join(d, name)));
    if (!dir) continue;
    let real;
    try { real = realpathSync(path.join(dir, name)); } catch { continue; }
    // node.exe sits at the top of a Windows install; elsewhere tools are in <prefix>/bin (Git for Windows: cmd/).
    const prefix = platform === "win32" && tool === "node" ? path.dirname(real) : path.dirname(path.dirname(real));
    if (inside(home, prefix) && path.resolve(prefix) !== path.resolve(home) && !found.includes(prefix)) found.push(prefix);
  }
  return found;
}

/** The sandbox settings for checks in one worktree: write only there, no network, nothing of yours to read. */
export function checkSandboxConfig({ cwd, tempDir = null, platform = process.platform, home = os.homedir(), env = process.env, srtWinPath } = {}) {
  const root = path.resolve(cwd);
  const tools = toolchainDirs({ env, home, platform });
  const windows = platform === "win32";
  const gitEntry = path.join(root, ".git");
  return {
    network: { allowedDomains: [], deniedDomains: [] },
    filesystem: {
      denyRead: windows ? [] : [home, ...HOME_SECRETS.map((p) => path.join(home, p))],
      allowRead: windows ? tools : [root, ...tools],
      allowWrite: tempDir ? [root, tempDir] : [root],
      // Git's folder (hooks, config) or a linked worktree's .git file: a check that changed them would run its
      // code later in Git commands Agent Dock runs as you. Only existing paths: a deny on a missing path makes
      // srt create a placeholder there.
      denyWrite: existsSync(gitEntry) ? [gitEntry] : [],
    },
    ...(windows ? { windows: { srtWin: { path: srtWinPath } } } : {}),
  };
}

let runtime = null;
/** Tests: a stand-in for @anthropic-ai/sandbox-runtime. */
export function useSandboxRuntime(fake) { runtime = fake; session = null; }
async function sandboxRuntime() {
  runtime ??= await import("@anthropic-ai/sandbox-runtime");
  return runtime;
}

/** Why the sandbox cannot run on this computer, or null when it is ready. */
export async function sandboxProblem() {
  if (!["win32", "linux"].includes(process.platform)) return `the sandbox for checks is not available on ${process.platform}`;
  let srt;
  try { srt = await sandboxRuntime(); } catch (error) { return `the sandbox runtime is missing from this installation (${error.message})`; }
  const deps = await (process.platform === "win32"
    ? srt.checkWindowsDependenciesAsync({ srtWin: srt.resolveSrtWin({ path: srt.VENDORED_SRT_WIN_EXE }) })
    : srt.SandboxManager.checkDependenciesAsync()).catch((error) => ({ errors: [error.message] }));
  if (!deps.errors?.length) return null;
  if (process.platform === "win32" && deps.errors.some((e) => /not provisioned|WFP filters not installed/.test(e))) return "the Windows sandbox is not set up yet (Settings › Experimental sets it up, with one administrator prompt)";
  return deps.errors.join("; ");
}

// One configuration at a time (the runtime is per process), kept while checks run in the same worktree.
let session = null;

// Wraps a command for the session (Linux: srt points the command's TMPDIR at the session's temp folder).
async function wrapCommand(manager, command, root, windows, windowsShell) {
  const before = process.env.CLAUDE_CODE_TMPDIR;
  if (session?.tempDir) process.env.CLAUDE_CODE_TMPDIR = session.tempDir;
  try {
    return await manager.wrapWithSandboxArgv(command, windows ? windowsShell : "/bin/sh", undefined, undefined, root);
  } finally {
    if (before === undefined) delete process.env.CLAUDE_CODE_TMPDIR; else process.env.CLAUDE_CODE_TMPDIR = before;
  }
}

/**
 * Guard plan stage 2: before the first check of a session, a small Node script runs inside the new sandbox. It
 * must not be able to read a marker file Agent Dock puts in your home folder, its write of a file there must not
 * appear in the real folder, and it must not open a connection. (Linux hides your home folder behind an empty
 * stand-in, where reads and writes succeed but reach nothing of yours, so results are checked against the real
 * folder.) A property that holds nothing back fails the check: the sandbox is not what it claims. A probe that cannot run at all
 * (no Node on PATH for this project) is noted in session.probe and the checks go on in the sandbox as before.
 */
async function probeSession(manager, root, windows, windowsShell) {
  const home = os.homedir(), name = `.agent-dock-probe-${randomBytes(8).toString("hex")}`;
  const outside = path.join(home, `${name}-write`), marker = path.join(home, `${name}-read`), token = randomBytes(16).toString("hex");
  // The script reports what it could do; whether that reached your real folder is judged here, not in there.
  const script = `const fs=require("fs"),net=require("net"),r={},a=${JSON.stringify({ outside, marker })};`
    + `try{fs.writeFileSync(a.outside,"x");r.outsideWrite="attempted"}catch(e){r.outsideWrite=e.code||"error"}`
    + `try{r.homeRead=fs.readFileSync(a.marker,"utf8")}catch(e){r.homeRead=e.code||"error"}`
    + `const s=net.connect({host:"example.com",port:443});const done=v=>{r.network=v;s.destroy();console.log("ADK_PROBE "+JSON.stringify(r));process.exit(0)};`
    + `s.setTimeout(4000,()=>done("timeout"));s.on("connect",()=>done("ok"));s.on("error",e=>done(e.code||"error"));`;
  // Base64 keeps the script one quote-free word for cmd, PowerShell and sh alike.
  const command = `node -e "eval(Buffer.from('${Buffer.from(script).toString("base64")}','base64').toString())"`;
  const wrapped = await wrapCommand(manager, command, root, windows, windowsShell);
  let output = "", wrote = false;
  try {
    // A home folder Agent Dock can't write to (read-only homes) only skips the read test.
    try { writeFileSync(marker, token, { mode: 0o600 }); } catch { /* the probe still checks writes and network */ }
    output = await new Promise((resolve) => {
      let out = "";
      const child = spawn(wrapped.argv[0], wrapped.argv.slice(1), { cwd: root, env: windows ? checkEnv(wrapped.env) : checkEnv(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      const timer = setTimeout(() => { child.kill(); resolve(out); }, 30_000);
      child.stdout.on("data", (c) => { out += c; });
      child.on("error", () => { clearTimeout(timer); resolve(out); });
      child.on("close", () => { clearTimeout(timer); resolve(out); });
    });
  } finally {
    try { if (!windows) manager.cleanupAfterCommand?.(); } finally { wrote = existsSync(outside); for (const file of [outside, marker]) try { rmSync(file, { force: true }); } catch { /* left behind: a hidden dot file */ } }
  }
  const line = output.split(/\r?\n/).find((l) => l.startsWith("ADK_PROBE "));
  // A write that reached your folder counts even when the probe printed nothing.
  const silent = wrote ? { ran: true, results: {}, leaked: ["outsideWrite"] } : { ran: false };
  if (!line) return silent;
  let results;
  try { results = JSON.parse(line.slice("ADK_PROBE ".length)); } catch { return silent; }
  const leaked = [...(wrote ? ["outsideWrite"] : []), ...(results.homeRead === token ? ["homeRead"] : []), ...(results.network === "ok" ? ["network"] : [])];
  if (results.homeRead === token) results.homeRead = "read your file";
  return { ran: true, results, leaked };
}

/** What the current session's probe found ({ran:false} when it could not run), or null with no session. */
export const sandboxProbe = () => session?.probe ?? null;
let queue = Promise.resolve();

/**
 * How to spawn one check inside the sandbox: { file, args, env, release }. release() must be called once the
 * check's process has closed; checks of one engine run one after another. A sandbox that cannot start throws,
 * so the check fails instead of running unsandboxed.
 */
export async function sandboxedSpawn(command, cwd, { windowsShell = "cmd", env = {} } = {}) {
  const previous = queue;
  let unlock;
  queue = new Promise((resolve) => (unlock = resolve));
  await previous;
  try {
    const srt = await sandboxRuntime();
    const manager = srt.SandboxManager;
    const root = path.resolve(cwd);
    const windows = process.platform === "win32";
    if (session?.cwd !== root) {
      await closeSandbox();
      // Linux: a temp folder of the session's own (srt points TMPDIR at it). Windows: the sandbox account has its own.
      const tempDir = windows ? null : mkdtempSync(path.join(os.tmpdir(), "agent-dock-check-"));
      session = { cwd: root, tempDir };
      // A session counts as ready only once it started and its probe held; any failure on the way ends it, so the
      // next check sets it up (and probes it) again instead of reusing it.
      try {
        await manager.initialize(checkSandboxConfig({ cwd: root, tempDir, srtWinPath: srt.VENDORED_SRT_WIN_EXE }));
        session.probe = await probeSession(manager, root, windows, windowsShell);
        if (session.probe.leaked?.length) throw new Error(`a probe inside it was not stopped (${session.probe.leaked.join(", ")})`);
      } catch (error) {
        await closeSandbox();
        throw error;
      }
    }
    const wrapped = await wrapCommand(manager, command, root, windows, windowsShell);
    // Windows: srt's env is for its broker only (the check gets the sandbox account's own environment plus
    // PATH). Linux: the check inherits it, so it gets the same environment an unsandboxed check gets.
    const spawnEnv = windows ? checkEnv(wrapped.env) : { ...checkEnv(), ...env };
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      try { if (!windows) manager.cleanupAfterCommand?.(); } finally { unlock(); }
    };
    return { file: wrapped.argv[0], args: wrapped.argv.slice(1), env: spawnEnv, release };
  } catch (error) {
    unlock();
    throw new Error(`The sandbox for checks could not start, so the check did not run: ${error.message}`);
  }
}

/** Ends the sandbox session (Windows: removes the folder grants it added). */
export async function closeSandbox() {
  if (!session) return;
  const { tempDir } = session;
  session = null;
  if (runtime) await runtime.SandboxManager.reset().catch(() => {});
  if (tempDir) try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* left for the OS to clean */ }
}
