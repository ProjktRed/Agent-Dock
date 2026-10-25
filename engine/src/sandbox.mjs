import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { withoutSecrets } from "./secret-env.mjs";

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

// Sign-ins and keys under your home folder. Linux hides the whole home folder already; these stay hidden
// even when the worktree or a toolchain folder beneath home is let back in. (Windows needs no list: the
// sandbox account cannot open your profile at all.)
const HOME_SECRETS = [".ssh", ".aws", ".azure", ".gnupg", ".docker", ".kube", ".codex", ".claude", ".config/gh", ".config/gcloud", ".config/Agent Dock", ".local/share/keyrings", ".npmrc", ".git-credentials", ".netrc", ".pypirc"];

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
      await manager.initialize(checkSandboxConfig({ cwd: root, tempDir, srtWinPath: srt.VENDORED_SRT_WIN_EXE }));
    }
    const before = process.env.CLAUDE_CODE_TMPDIR;
    if (session.tempDir) process.env.CLAUDE_CODE_TMPDIR = session.tempDir;
    let wrapped;
    try {
      wrapped = await manager.wrapWithSandboxArgv(command, windows ? windowsShell : "/bin/sh", undefined, undefined, root);
    } finally {
      if (before === undefined) delete process.env.CLAUDE_CODE_TMPDIR; else process.env.CLAUDE_CODE_TMPDIR = before;
    }
    // Windows: srt's env is for its broker only (the check gets the sandbox account's own environment plus
    // PATH). Linux: the check inherits it, so it gets the same environment an unsandboxed check gets.
    const spawnEnv = windows ? withoutSecrets(wrapped.env) : { ...withoutSecrets(), ...env };
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
