import { createHash, randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { isProtectedPath, pathsIn } from "./protected-paths.mjs";
import { redactText } from "../redact.mjs";
import { readsCodeFromInput } from "./stdin-commands.mjs";

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
  // Shells join quoted pieces and drop escapes (`.e''nv`, `.e\nv`, PowerShell's .e`nv and cmd's .e^nv are all
  // .env): the word with quotes, and with quotes and backslashes or carets, removed is split and checked too, and
  // bash's $'…' with its escapes decoded (`$'.e\x6ev'`; kadono 0.40.1 probe; cmd's ^, guard review). More names
  // only refuse more.
  const joined = [word, expanded, ansiC(word)].flatMap((w) => [w.replace(/["'`]/g, ""), w.replace(/["'`\\]/g, ""), w.replace(/["'`^]/g, "")]);
  // Brace expansion: `.{env,x}` is `.env` and `.x` (a few levels, bounded).
  for (let i = 0; i < joined.length && joined.length < 200; i++) {
    const brace = /\{([^{}]*,[^{}]*)\}/.exec(joined[i]);
    if (brace) joined.push(...brace[1].split(",").map((alt) => joined[i].slice(0, brace.index) + alt + joined[i].slice(brace.index + brace[0].length)));
  }
  const pieces = [word, expanded, ...joined].flatMap((w) => w.split(/["'`{}=,]+/)).flatMap((w) => w.split(/(?<!(?:^|[^A-Za-z0-9_])[A-Za-z]):|:(?![\\/])/));
  return [...new Set(pieces.filter(Boolean))];
}

// bash's $'…' strings with their escapes decoded (\xHH, \uHHHH, \UHHHHHHHH, octal, \cX and the letter escapes).
const ESCAPES = { a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" };
function ansiC(word) {
  return word.replace(/\$'((?:[^'\\]|\\.)*)'?/g, (m, body) => body.replace(/\\(x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|U[0-9a-fA-F]{1,8}|[0-7]{1,3}|c.|.)/g, (e, s) => {
    if (/^[xuU]/.test(s)) { try { return String.fromCodePoint(parseInt(s.slice(1), 16)); } catch { return ""; } }
    if (/^[0-7]/.test(s)) return String.fromCharCode(parseInt(s, 8) & 0xff);
    if (s[0] === "c") return String.fromCharCode(s.charCodeAt(1) & 0x1f);
    return ESCAPES[s] ?? s;
  }));
}

const GLOB = /[*?[]/;
// A wildcard part that is nothing but * and ? names everything alike, not a protected name; a bracket expression
// (`[s]*`) narrows it, so it doesn't count (release review 0.40.2).
const matchesAll = (part) => /^[*?]+$/.test(part);
const foldCase = process.platform === "win32" || process.platform === "darwin";
/** A shell or PowerShell wildcard as a regular expression for one name (a leading dot matches too, as in PowerShell). */
function globPattern(part) {
  let out = "";
  for (let i = 0; i < part.length; i++) {
    const c = part[i];
    if (c === "*") out += ".*";
    else if (c === "?") out += ".";
    else if (c === "[") {
      // Any bracket expression (POSIX classes like [[:alpha:]] included) counts as any one character: wider only refuses more.
      const end = part.indexOf("]", part[i + 1] === "[" ? part.indexOf("]", i + 2) + 1 : i + 2);
      if (end < 0) { out += "\\["; continue; }
      out += "."; i = end;
    } else out += c.replace(/[.+^${}()|\\\]]/g, "\\$&");
  }
  try { return new RegExp(`^${out}$`, foldCase ? "i" : ""); } catch { return /^$/; }
}

/**
 * What a wildcard word could name: its matches on disk (a few levels, bounded), and the protected rules' own names
 * it fits (`.e*`, `.[e]nv` and `*env` fit `.env*` even before a .env exists). Only refuses more, never allows.
 */
function globNames(policy, word, cwd) {
  const parts = word.replaceAll("\\", "/").split("/");
  const absolute = path.isAbsolute(word) || /^[A-Za-z]:/.test(word);
  let found = [absolute ? (parts[0] || "/") : cwd];
  const start = absolute ? 1 : 0;
  for (let i = start; i < parts.length && found.length; i++) {
    const part = parts[i];
    if (!part) continue;
    if (!GLOB.test(part)) { found = found.map((dir) => path.join(dir, part)); continue; }
    const test = globPattern(part);
    // Folders only, except for the last part (`*/notes.txt` never looks inside the file .env).
    const last = i === parts.length - 1;
    found = found.flatMap((dir) => { try { return readdirSync(dir, { withFileTypes: true }).filter((e) => test.test(e.name) && (last || e.isDirectory())).map((e) => path.join(dir, e.name)); } catch { return []; } }).slice(0, 2000);
  }
  const last = globPattern(parts.at(-1) || "");
  const ruleNames = (policy.protectedPaths ?? []).map((rule) => rule.replaceAll("\\", "/").replace(/\/+$/, "").split("/").at(-1).replace(/[*?]/g, "")).filter(Boolean);
  return { found, fitsRule: ruleNames.some((name) => last.test(name)) };
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
  // A shell reading code from input would run whatever Codex types into it later, unchecked.
  if (action.kind === "command" && commandText(action).split("\n").some((line) => readsCodeFromInput(line, cwd))) return true;
  const strings = (value, out = []) => {
    if (typeof value === "string") out.push(value);
    else if (value && typeof value === "object") for (const v of Object.values(value)) strings(v, out);
    return out;
  };
  const texts = action.kind === "command" ? words(commandText(action)) : strings(action.input).flatMap(words);
  const paths = action.kind === "command" ? [] : pathsIn(action.input);
  // A web address is no file name (the path check reads its colon as a drive and refuses it, to be safe).
  const names = [...paths, ...texts.filter((name) => !/^https?:\/\//i.test(name)).flatMap(nameCandidates)];
  if (names.some(protectedName)) return true;
  // Wildcards: refused outright when they could name a protected path (kadono 0.40.0 probe: `cat .e*`).
  // An expansion the guard can't resolve could produce a wildcard (`.e${UNSET:-*}`, `X=*; cat .e$X`, `.e$(echo '*')`):
  // it counts as one (kadono 0.40.1 review), cmd's %…%, for variables (%A, %~nA) and !…! too (`.g%ComSpec:~0,0%it`
  // is .git; guard review).
  // Wildcards that are nothing but wildcards (`ls *`, `src/*`, `echo $(date)`) single out no protected name, so they
  // are put to you instead (kadono 0.40.1 probe); their plain folders were checked with the names above.
  const raw = action.kind === "command" ? commandText(action).split(/\s+/) : [];
  const expanded = raw.map((w) => w.replace(/\$\{[^}]*\}|\$\([^)]*\)?|`[^`]*`?|\$[@*#?$!0-9-]|\$\w+|\$|%[^%\s]*%|%~[A-Za-z]+|%[A-Za-z]|![^!\s]*!/g, "*").replace(/["'`^]/g, "")).filter((w, i) => w !== raw[i].replace(/["'`^]/g, ""));
  return [...new Set([...names, ...texts.map((w) => w.replace(/["'`]/g, "")), ...expanded])].filter((name) => GLOB.test(name)).some((name) => {
    const parts = name.replaceAll("\\", "/").split("/");
    if (matchesAll(parts.at(-1)) && parts.every((part) => !GLOB.test(part) || matchesAll(part))) return false;
    const { found, fitsRule } = globNames(policy, name, cwd); return fitsRule || found.some(protectedName);
  });
}

export function askable(policy, action, decision, adapter) {
  return decision?.effect === "stop" && Boolean(policy.ask?.dir) && Number(policy.ask?.timeoutMs) > 0 && ASK_ADAPTERS.has(adapter?.id) && !definitelyRefused(policy, action);
}

const digest = (value) => createHash("sha256").update(value).digest("hex");
const preview = (action, limit) => redactText(commandText(action)).slice(0, limit);

// Actions allowed for this run: one file per action, named by the hash of what it is (no shared file to race on).
// It is bound to the whole tool call (not just the text shown), the policy, the task and the engine run, so it
// never carries over to another task, run or policy; the file keeps only digests and a short redacted preview.
const rememberedDir = (dir) => path.join(dir, "allowed-for-run");
function remembered(policy, adapter, action, cwd) {
  const what = {
    cli: adapter.label, tool: action.tool ?? null, cwd, taskId: policy.taskId ?? null, runId: policy.ask.runId ?? null,
    policy: digest(JSON.stringify({ ...policy, ask: null })), action: digest(JSON.stringify([commandText(action), action.input ?? null])),
  };
  return { what, file: path.join(rememberedDir(policy.ask.dir), `${digest(JSON.stringify(what))}.json`) };
}

/** A new engine run forgets what the last one allowed (parallel children share the parent's run). */
export async function startAskRun() {
  if (!configured) return;
  await rm(rememberedDir(configured.dir), { recursive: true, force: true }).catch(() => {});
  await mkdir(configured.dir, { recursive: true });
  await writeFile(path.join(configured.dir, "run-id"), randomBytes(16).toString("hex"), { mode: 0o600 });
}

/**
 * Writes the request and waits for the app's decision file. Resolves "allow", "allow-run" (allowed, and
 * remembered for this run), "remembered" (allowed earlier in this run), "deny" or "timeout".
 */
export async function askUser(policy, action, reason, adapter, { now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), pollMs = 500 } = {}) {
  const { dir, timeoutMs } = policy.ask;
  const cwd = action.cwd || policy.workspace;
  const memory = remembered(policy, adapter, action, cwd);
  const earlier = await readFile(memory.file, "utf8").then(JSON.parse, () => null);
  if (earlier && JSON.stringify(earlier.what) === JSON.stringify(memory.what)) return "remembered";
  await mkdir(dir, { recursive: true });
  const id = randomBytes(16).toString("hex");
  const createdAt = now();
  const request = {
    id, cli: adapter.label, tool: action.tool ?? null, kind: action.kind,
    text: preview(action, TEXT_LIMIT), reason: String(reason ?? "").slice(0, 500),
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
    await writeFile(memory.file, JSON.stringify({ what: memory.what, preview: preview(action, 200), id, at: new Date(now()).toISOString() }), { mode: 0o600 }).catch(() => {});
  }
  return outcome;
}

export const askAllowed = (outcome) => outcome === "allow" || outcome === "allow-run" || outcome === "remembered";

// Set once per engine (--ask-minutes): the run's own state folder, which the app watches.
let configured = null;
export function useActionAsk({ stateDir, minutes } = {}) {
  configured = stateDir && Number(minutes) > 0 ? { dir: path.join(path.resolve(stateDir), "approvals"), timeoutMs: Math.round(Number(minutes) * 60_000) } : null;
}
/** The run's id is read when a policy is written: parallel children and Elevation use their parent's run. */
export const actionAsk = () => {
  if (!configured) return null;
  let runId = null;
  try { runId = readFileSync(path.join(configured.dir, "run-id"), "utf8").trim() || null; } catch { /* No run started here yet. */ }
  return { ...configured, runId };
};

/** Hook timeout (seconds) a CLI must allow so the hook can wait for an answer. */
export const hookTimeoutSeconds = (policyAsk) => 30 + Math.ceil(Math.max(0, Number(policyAsk?.timeoutMs) || 0) / 1000);
