import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * Guard plan 0d: git that Agent Dock runs as you never runs code a repository (or an agent that changed its
 * .git folder) set up. Command-line settings beat every config file, so each call turns off fsmonitor, points
 * hooks at /dev/null (no folder can exist there, on Windows too) and
 * keeps file:// submodules from being fetched on their own; diff, show and log also skip external diff
 * programs and textconv. Your global settings (identity, credential helper, LFS) are kept.
 */
export const SAFE_GIT_CONFIG = Object.freeze(["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "protocol.file.allow=user"]);
const DIFFING = new Set(["diff", "show", "log"]);

/** The arguments of one git call, hardened. Existing `-c core.fsmonitor=false` pairs are folded in. */
export function safeGitArgs(args) {
  const rest = [...args];
  while (rest[0] === "-c" && rest[1] === "core.fsmonitor=false") rest.splice(0, 2);
  const sub = rest.findIndex((arg, i) => !arg.startsWith("-") && rest[i - 1] !== "-c");
  if (sub >= 0 && DIFFING.has(rest[sub])) rest.splice(sub + 1, 0, "--no-ext-diff", "--no-textconv");
  return [...SAFE_GIT_CONFIG, ...rest];
}

// Settings in the repository's own config that run a program and that a command-line value can't turn off
// without also dropping yours (a credential helper, an SSH command) or that git runs during stash, merge,
// checkout and commit (filters, merge drivers, GPG). Hooks, fsmonitor, external diff and textconv are covered by
// safeGitArgs instead, so husky's core.hooksPath is fine.
const RUNS_A_PROGRAM = [
  /^credential\.(?:.+\.)?helper$/, /^core\.(?:sshcommand|askpass|gitproxy|alternaterefscommand)$/, /^gpg\.(?:.+\.)?program$/,
  /^merge\..+\.driver$/, /^remote\..+\.(?:uploadpack|receivepack)$/, /^filter\..+\.(?:clean|smudge|process)$/,
  /^include\.path$/, /^includeif\..+\.path$/, /^diff\..+\.(?:textconv|command)$/, /^diff\.external$/, /^gpg\.ssh\.defaultkeycommand$/,
];
// Signing turned on by the repository would start GPG (or SSH signing) with your key for Agent Dock's commits.
const SIGNS = /^(?:commit|tag)\.gpgsign$/;
// Git LFS, as `git lfs install --local` writes it.
const LFS = /^git-lfs (?:clean|smudge|filter-process)(?: -- %f| --skip)?(?: -- %f)?$/;

/** The repository-scope settings that would run a program, as "key=value" lines; empty when there are none. */
export async function unsafeRepoConfig(workspace) {
  const { stdout } = await exec("git", [...SAFE_GIT_CONFIG, "config", "-z", "--list", "--show-scope"], { cwd: workspace, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  return unsafeConfigEntries(stdout);
}

/** The same, from `git config -z --list --show-scope` output. */
export function unsafeConfigEntries(stdout) {
  const found = [];
  // Each entry is the scope and then the key and value (separated by a newline), each ended by NUL.
  const fields = stdout.split("\0");
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const scope = fields[i], rest = fields[i + 1];
    if (!["local", "worktree"].includes(scope)) continue;
    // A key never holds whitespace: a git that ends it with \r\n still names the same setting.
    const newline = rest.indexOf("\n"), key = (newline < 0 ? rest : rest.slice(0, newline)).trim().toLowerCase(), value = newline < 0 ? "" : rest.slice(newline + 1);
    if (SIGNS.test(key) ? /^(?:false|no|off|0)$/i.test(value.trim()) : !RUNS_A_PROGRAM.some((re) => re.test(key))) continue;
    if (/^filter\.lfs\.(?:clean|smudge|process)$/.test(key) && LFS.test(value.trim())) continue;
    found.push(`${key}=${value}`);
  }
  return found;
}

const real = (p) => { try { return realpathSync.native(p); } catch { return path.resolve(p); } };
const same = (a, b) => process.platform === "win32" ? real(a).toLowerCase() === real(b).toLowerCase() : real(a) === real(b);

/**
 * Before a run: the Git folder of the workspace's repository must be its own .git or a
 * linked worktree that repository has registered for exactly this folder (a .git file pointing somewhere else
 * is refused), and its own config must not name a program git would run. Throws with what to fix.
 */
export async function assertSafeRepository(workspace) {
  const run = async (...args) => (await exec("git", safeGitArgs(args), { cwd: workspace, windowsHide: true })).stdout.trim();
  const top = path.resolve(workspace, await run("rev-parse", "--show-toplevel"));
  const gitDir = path.resolve(workspace, await run("rev-parse", "--path-format=absolute", "--git-dir"));
  if (!same(gitDir, path.join(top, ".git"))) {
    // A linked worktree: <common>/worktrees/<name>/gitdir names this folder's .git file.
    const registered = await readFile(path.join(gitDir, "gitdir"), "utf8").then((t) => t.trim(), () => null);
    const common = path.resolve(workspace, await run("rev-parse", "--path-format=absolute", "--git-common-dir"));
    const listed = await readdir(path.join(common, "worktrees")).then((names) => names.some((n) => same(path.join(common, "worktrees", n), gitDir)), () => false);
    if (!registered || !listed || !same(registered, path.join(top, ".git"))) throw new Error(`This project's .git points to ${gitDir}, which is not a worktree its repository registered for this folder. Agent Dock won't run git here.`);
  }
  const unsafe = await unsafeRepoConfig(workspace);
  if (unsafe.length) throw new Error(`This repository's own Git config runs programs Agent Dock won't let git start for you: ${unsafe.map((line) => line.slice(0, 200)).join("; ")}. Remove them with git config --local --unset <key> (or move them to your global config if you set them yourself).`);
}
