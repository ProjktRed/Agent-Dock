import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { isProtectedPath, pathsIn } from "./protected-paths.mjs";

/**
 * Ask instead of refuse (Settings › Execution & safety, "When the guard cannot verify an action"). A Codex or
 * Claude Code tool call the guard refuses only because it cannot prove the call safe (an unknown tool, a shell
 * command it cannot parse) is put to you instead: the hook writes a request into the project's state folder,
 * the app asks you (in its window, Telegram), and the hook waits for the answer or the time limit (then it is
 * refused, as before). The state folder is protected from agents, and a request's random id never reaches the
 * agent, so only the app can answer. "Allow for this run" remembers that exact action (same CLI, tool, folder
 * and text) until the engine run ends; the next identical one is allowed without asking.
 *
 * Never askable: anything that names a protected path (or runs in one), and edits (outside the task's paths
 * they would fail its scope check anyway).
 */
export const ASK_ADAPTERS = new Set(["codex", "claude"]);
const TEXT_LIMIT = 2000;

/** The words of a shell command, quotes removed: enough to see a protected path it names. */
function words(text) {
  return String(text).split(/[\s;|&()<>]+/).map((w) => w.replace(/^["'`]+|["'`,]+$/g, "")).filter(Boolean);
}

/**
 * The file names a word could stand for. Code inside a command (`node -e "…c?1:0…"`) is no file name: a
 * quote, brace, equals sign or comma, or a colon that is not a drive letter's (`C:\`), splits it, and each
 * piece is checked (`-Path:.env` and `-Path:C:\…` still name their paths; wildcards stay in their word).
 * Environment variables are expanded as well, so `$env:APPDATA\…` is checked where it points. Only decides
 * refuse-outright versus ask: never allows anything.
 */
function nameCandidates(word) {
  const expanded = word
    .replace(/\$\{env:(\w+)\}|\$env:(\w+)|%(\w+)%|\$\{?(\w+)\}?/gi, (m, a, b, c, d) => process.env[a ?? b ?? c ?? d] ?? m)
    .replace(/^~(?=$|[\\/])/, process.env.USERPROFILE ?? process.env.HOME ?? "~");
  const pieces = [word, expanded].flatMap((w) => w.split(/["'`{}=,]+/)).flatMap((w) => w.split(/(?<!(?:^|[^A-Za-z0-9_])[A-Za-z]):|:(?![\\/])/));
  return [...new Set(pieces.filter(Boolean))];
}

function commandText(action) {
  const commands = (action.commands ?? []).map((c) => (typeof c === "string" ? c : [c?.command, ...(c?.args ?? [])].join(" ")));
  return commands.length ? commands.join("\n") : JSON.stringify(action.input ?? null);
}

/** The refusal is certain (a protected path, an edit), not just unverified: never put to the user. */
export function definitelyRefused(policy, action) {
  if (action.kind === "edit" || action.kind === "read" || action.kind === "web") return true;
  const cwd = action.cwd || policy.workspace;
  const protectedName = (file) => { try { return isProtectedPath(policy, file, cwd); } catch { return true; } };
  if (protectedName(cwd)) return true;
  const strings = (value, out = []) => {
    if (typeof value === "string") out.push(value);
    else if (value && typeof value === "object") for (const v of Object.values(value)) strings(v, out);
    return out;
  };
  const texts = action.kind === "command" ? words(commandText(action)) : strings(action.input).flatMap(words);
  const paths = action.kind === "command" ? [] : pathsIn(action.input);
  // A web address is no file name (the path check reads its colon as a drive and refuses it, to be safe).
  return [...paths, ...texts.filter((name) => !/^https?:\/\//i.test(name)).flatMap(nameCandidates)].some(protectedName);
}

export function askable(policy, action, decision, adapter) {
  return decision?.effect === "stop" && Boolean(policy.ask?.dir) && Number(policy.ask?.timeoutMs) > 0 && ASK_ADAPTERS.has(adapter?.id) && !definitelyRefused(policy, action);
}

// Actions allowed for this run: one file per action, named by the hash of what it is (no shared file to race on).
const rememberedDir = (dir) => path.join(dir, "allowed-for-run");
function remembered(dir, adapter, action, cwd) {
  const what = { cli: adapter.label, tool: action.tool ?? null, cwd, text: commandText(action) };
  return { what, file: path.join(rememberedDir(dir), `${createHash("sha256").update(JSON.stringify(what)).digest("hex")}.json`) };
}

/** A new engine run forgets what the last one allowed (parallel children share the parent's run). */
export async function startAskRun() {
  if (configured) await rm(rememberedDir(configured.dir), { recursive: true, force: true }).catch(() => {});
}

/**
 * Writes the request and waits for the app's decision file. Resolves "allow", "allow-run" (allowed, and
 * remembered for this run), "remembered" (allowed earlier in this run), "deny" or "timeout".
 */
export async function askUser(policy, action, reason, adapter, { now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), pollMs = 500 } = {}) {
  const { dir, timeoutMs } = policy.ask;
  const cwd = action.cwd || policy.workspace;
  const memory = remembered(dir, adapter, action, cwd);
  const earlier = await readFile(memory.file, "utf8").then(JSON.parse, () => null);
  if (earlier && JSON.stringify(earlier.what) === JSON.stringify(memory.what)) return "remembered";
  await mkdir(dir, { recursive: true });
  const id = randomBytes(16).toString("hex");
  const createdAt = now();
  const request = {
    id, cli: adapter.label, tool: action.tool ?? null, kind: action.kind,
    text: commandText(action).slice(0, TEXT_LIMIT), reason: String(reason ?? "").slice(0, 500),
    cwd, taskId: policy.taskId ?? null,
    createdAt: new Date(createdAt).toISOString(), expiresAt: new Date(createdAt + timeoutMs).toISOString(),
  };
  const requestFile = path.join(dir, `${id}.request.json`), decisionFile = path.join(dir, `${id}.decision.json`);
  await writeFile(`${requestFile}.tmp`, JSON.stringify(request), { mode: 0o600 });
  await rename(`${requestFile}.tmp`, requestFile);
  let outcome = "timeout";
  try {
    while (now() - createdAt < timeoutMs) {
      const decision = await readFile(decisionFile, "utf8").then(JSON.parse, () => null);
      if (decision?.id === id && (decision.decision === "allow" || decision.decision === "deny")) { outcome = decision.decision === "allow" && decision.remember === true ? "allow-run" : decision.decision; break; }
      await sleep(pollMs);
    }
  } finally {
    // The request is answered (or expired) either way: the app stops offering it.
    await writeFile(path.join(dir, `${id}.done.json`), JSON.stringify({ id, outcome, at: new Date(now()).toISOString() })).catch(() => {});
    await rm(requestFile, { force: true }).catch(() => {});
  }
  if (outcome === "allow-run") {
    await mkdir(rememberedDir(dir), { recursive: true });
    await writeFile(memory.file, JSON.stringify({ what: memory.what, id, at: new Date(now()).toISOString() }), { mode: 0o600 }).catch(() => {});
  }
  return outcome;
}

export const askAllowed = (outcome) => outcome === "allow" || outcome === "allow-run" || outcome === "remembered";

// Set once per engine (--ask-minutes): the run's own state folder, which the app watches.
let configured = null;
export function useActionAsk({ stateDir, minutes } = {}) {
  configured = stateDir && Number(minutes) > 0 ? { dir: path.join(path.resolve(stateDir), "approvals"), timeoutMs: Math.round(Number(minutes) * 60_000) } : null;
}
export const actionAsk = () => configured;

/** Hook timeout (seconds) a CLI must allow so the hook can wait for an answer. */
export const hookTimeoutSeconds = (policyAsk) => 30 + Math.ceil(Math.max(0, Number(policyAsk?.timeoutMs) || 0) / 1000);
