import { execFile, spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, readdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { atomicWriteJson, DashboardState } from "./dashboard-state.mjs";
import { mergeDeferred, objectiveWithDeferred } from "./defer-task.mjs";
import { taskPrioritySection } from "./task-priority.mjs";
import { assertSafeQaCommand } from "./guard/protected-paths.mjs";
import { noteStepDownApproval } from "./engine-tuning.mjs";
import { validateTask } from "./node-loop.mjs";
import { runCheckCommand } from "./qa-runner.mjs";
import { addRunElevations, addRunUsage, BUDGET_FLAGS, elevationBudget, RUN_USAGE_FILE } from "./run-budget.mjs";

// Parallel tasks in one run (0.35, --parallel N). Each round, Assessment picks up to N tasks whose
// allowed files do not overlap. Every task then runs through a complete engine of its own (Implementation,
// QA, its commit) in a git worktree next to the project, on its own branch, at the same time. The run then
// brings each approved commit into your branch one by one: it applies the change without committing,
// runs that task's check command on the combined code, and commits only if the check passes. A change
// that does not apply or fails its check is not committed; its branch is kept for you and the work
// goes back to Assessment. Worktrees of tasks that did not finish are left in place to inspect.
// Between rounds the run follows Stop and Pause as the normal loop does between tasks (Automatic
// continuation off pauses after a round that merged a change). A task that fails to merge twice stops for you.
// One budget for the whole run (Unattended mode too): a task's engine runs without token, spend, task or time
// limits of its own. While a round runs, the run counts each task engine's usage so far (run-usage.json in
// its state folder) toward its own run and day totals, and a limit reached there stops every task.

const exec = promisify(execFile);
const git = (cwd, args) => exec("git", ["-c", "core.fsmonitor=false", ...args], { cwd, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }).then((r) => r.stdout.trim());
const firstLine = (text, max) => String(text ?? "").split(/\r?\n/)[0].slice(0, max);

const overlaps = (a, b) => a.allowedPaths.some((x) => b.allowedPaths.some((y) => x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`)));

/** The worktree folder for a task: next to the project, like parallel lanes. */
export const worktreeFor = (workspace, taskId) => path.join(path.dirname(workspace), `${path.basename(workspace)}-parallel`, String(taskId).replace(/[^\w.-]+/g, "_"));

/** A free worktree folder: kept worktrees of earlier runs are never reused, nor one name twice in a round
 *  (taken: the round's names in lower case, as ids that clean up alike or differ only in case would share one). */
export function freeWorktree(workspace, name, taken = new Set()) {
  let worktree = worktreeFor(workspace, name);
  for (let i = 2; existsSync(worktree) || taken.has(path.basename(worktree).toLowerCase()); i++) worktree = worktreeFor(workspace, `${name}-${i}`);
  taken.add(path.basename(worktree).toLowerCase());
  return worktree;
}

/** Removes a worktree's node_modules link, never what it points to: `git worktree remove` follows
 *  the junction and would delete the project's own node_modules. */
export function unlinkModules(worktree) {
  const link = path.join(worktree, "node_modules");
  let stat;
  try { stat = lstatSync(link); } catch { return; }
  if (!stat.isSymbolicLink()) return;
  try { unlinkSync(link); } catch { rmdirSync(link); }
}

async function removeWorktree(workspace, worktree) {
  unlinkModules(worktree);
  await git(workspace, ["worktree", "remove", "--force", worktree]);
}

const SIZE_FLAGS = ["--task-mode", "--task-max-files", "--task-max-new-lines", "--task-max-read-files"];

/** --supervisor, --supervisor-* and --sv-*: the parent's Supervisor watches the run; a task's engine runs none. */
const supervisorFlag = (name) => name === "--supervisor" || name.startsWith("--supervisor-") || name.startsWith("--sv-");

/** --protected-paths for a task's engine: an absolute entry inside the project names the same path in the worktree. */
function rebaseProtected(value, workspace, worktree) {
  let paths;
  try { paths = JSON.parse(value); } catch { return value; }
  if (!workspace || !Array.isArray(paths)) return value;
  return JSON.stringify(paths.map((entry) => {
    if (typeof entry !== "string" || !path.isAbsolute(entry.trim())) return entry;
    const rel = path.relative(path.resolve(workspace), path.resolve(entry.trim()));
    return rel.startsWith("..") || path.isAbsolute(rel) ? entry : path.join(worktree, rel);
  }));
}

/** Child engine arguments: the parent's, for one task in its worktree with its own state folder.
 *  No step-down in a task's engine: the parent plans the next round. sizing (the parent's tuning while it is
 *  stepped down) replaces the configured task size, so the task's engine works at the size it was planned for.
 *  No Supervisor either (no alerts, model review or digests of its own): the parent supervises the whole run.
 *  No budget of its own (tokens, spend, tasks, hours): the parent counts its usage and stops it at the run's limits. */
/**
 * The run's Elevation limit shared by a round's task engines: what is left is split between them, the first
 * ones getting any remainder, so together they never use more than the limit. null: no limit. A task given
 * none runs without automatic Elevation.
 */
export function shareElevations({ max = 0, used = 0 } = {}, count) {
  if (!max) return Array(count).fill(null);
  const left = Math.max(0, max - used), each = Math.floor(left / count), extra = left % count;
  return Array.from({ length: count }, (_, i) => each + (i < extra ? 1 : 0));
}

export function childArgs(argv, { worktree, stateDir, taskFile, sizing = null, elevations = null }) {
  const limited = Number.isInteger(elevations);
  const drop = new Set(["--workspace", "--state-dir", "--task", "--parallel", "--max-rounds", "--single-task", "--auto-continue", "--step-down", "--local-server-managed", "--parallel-child", ...BUDGET_FLAGS, ...(sizing ? SIZE_FLAGS : []), ...(limited ? ["--max-elevations"] : []), ...(limited && elevations === 0 ? ["--sol-reassessment"] : [])]);
  let workspace = null;
  for (let i = 0; i < argv.length; i += 2) if (argv[i] === "--workspace") workspace = argv[i + 1];
  const out = [];
  for (let i = 0; i < argv.length; i += 2) {
    if (drop.has(argv[i]) || supervisorFlag(argv[i])) continue;
    out.push(argv[i], argv[i] === "--protected-paths" ? rebaseProtected(argv[i + 1], workspace, worktree) : argv[i + 1]);
  }
  const size = sizing ? ["--task-mode", sizing.taskMode, "--task-max-files", String(sizing.taskMaxFiles), "--task-max-new-lines", String(sizing.taskMaxNewLines), "--task-max-read-files", String(sizing.taskMaxReadFiles)] : [];
  const share = !limited ? [] : elevations > 0 ? ["--max-elevations", String(elevations)] : ["--sol-reassessment", "false"];
  return [...out, ...size, ...share, "--workspace", worktree, "--state-dir", stateDir, "--task", taskFile, "--single-task", "true", "--auto-continue", "true", "--step-down", "false", "--supervisor", "off", "--local-server-managed", "external", "--parallel-child", "true"];
}

/** A task engine's environment: the parent's without AGENT_DOCK_NOTIFY, so only the parent sends notifications. */
export function childEnv(env = process.env) {
  const out = {};
  for (const [name, value] of Object.entries(env)) if (name.toUpperCase() !== "AGENT_DOCK_NOTIFY") out[name] = value;
  return out;
}

/** child.json in a task engine's state folder: its pid and parent, when it ended, and whether its usage was imported. */
const CHILD_RECORD = "child.json";
/** parallel-round.json in the run's state folder: the round in progress (or the last one, with endedAt). */
export const ROUND_FILE = "parallel-round.json";
export const readChildRecord = (childState) => { try { return JSON.parse(readFileSync(path.join(childState, CHILD_RECORD), "utf8")); } catch { return null; } };
export function writeChildRecord(childState, fields) {
  const next = { ...(readChildRecord(childState) ?? {}), ...fields };
  try { mkdirSync(childState, { recursive: true }); writeFileSync(path.join(childState, CHILD_RECORD), `${JSON.stringify(next, null, 2)}\n`); } catch {}
  return next;
}

/** onMerged for a run: a merged task counts toward ending a step-down, as an approved task does in the normal loop. */
export const endStepDown = (onEvent) => async (task) => {
  const restored = noteStepDownApproval(task);
  if (restored) await onEvent({ type: "task-mode-restored", mode: restored.mode, from: restored.from });
};

/** Runs one child engine to the end of its task; resolves with its loop result, approved commit and usage. */
export function spawnChildEngine({ cliPath, args, stateDir, env = process.env }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], { env: childEnv(env), windowsHide: true, stdio: "ignore" });
    // Its pid, so a run that restarts after this one crashed finds the engine still at work (stopOrphanChildren).
    if (child.pid) writeChildRecord(stateDir, { pid: child.pid, parentPid: process.pid, startedAt: new Date().toISOString(), exitedAt: null });
    child.on("error", (error) => resolve({ status: "blocked", output: error.message }));
    child.on("close", () => {
      if (child.pid) writeChildRecord(stateDir, { exitedAt: new Date().toISOString() });
      const read = (name) => { try { return JSON.parse(readFileSync(path.join(stateDir, name), "utf8")); } catch { return null; } };
      const result = read("loop-result.json") ?? { status: "blocked", output: "The task's engine ended without a result." };
      resolve({ ...result, commit: read("last-result.json")?.result?.qa?.commit ?? null, usage: read("run-report.json")?.usage ?? null });
    });
  });
}

/** Brings a task engine's per-role usage into the run's state folder, where Overview reads it: each model call's
 *  usage lines and the head of its prompt (which names the role), dated as the call was, and the last metrics
 *  sample of each Implementation attempt as an event of the run. Run totals come from addRunUsage instead. */
export async function importChildUsage({ childState, stateDir, taskId, onEvent }) {
  const from = path.join(childState, "codex");
  for (const name of await readdir(from).catch(() => [])) {
    const events = path.join(from, name, "events.ndjson");
    const info = await stat(events).catch(() => null);
    const target = path.join(stateDir, "codex", name);
    if (!info || existsSync(target)) continue;
    // Only the lines with usage: a copied call never looks like one of the run's own (a usage-limit wait).
    const usage = (await readFile(events, "utf8")).split(/\r?\n/).filter((line) => line.includes('"usage"'));
    if (!usage.length) continue;
    const prompt = await readFile(path.join(from, name, "prompt.txt"), "utf8").catch(() => "");
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "prompt.txt"), prompt.slice(0, 2000));
    await writeFile(path.join(target, "events.ndjson"), `${usage.join("\n")}\n`);
    await utimes(path.join(target, "events.ndjson"), info.atime, info.mtime);
    await utimes(target, info.atime, info.mtime);
  }
  // As Overview counts them: a newer sample of an attempt replaces a partial one, the final one stays.
  const latest = new Map();
  const lines = (await readFile(path.join(childState, "activity.ndjson"), "utf8").catch(() => "")).split(/\r?\n/);
  lines.forEach((line, i) => {
    let event;
    try { event = JSON.parse(line); } catch { return; }
    if (event?.type !== "cline-provider-metrics") return;
    const key = typeof event.runStartedAt === "string" ? event.runStartedAt : `line-${i}`;
    if (!latest.has(key) || latest.get(key).partial === true) latest.set(key, event);
  });
  for (const event of latest.values()) await onEvent({ ...event, taskId, parallel: true });
}

const USAGE_FIELDS = ["input", "cached", "output", "costUsd", "estimatedUsd", "calls"];
const usageNumber = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0);

/** A task engine's usage so far, from run-usage.json in its state folder (written as each call is counted). */
export const readLiveUsage = (childState) => { try { return JSON.parse(readFileSync(path.join(childState, RUN_USAGE_FILE), "utf8")); } catch { return null; } };

/**
 * Counts what a task engine used since the run last counted it (usageCounted in its child.json), so each
 * token counts once whether it was seen while the task worked or in its final report.
 * The counted total moves on before the run's own totals do, so two counts at the same time never add it twice.
 */
export async function countChildUsage({ childState, usage, addUsage }) {
  if (!usage) return false;
  const counted = readChildRecord(childState)?.usageCounted ?? {};
  const delta = {}, total = {};
  for (const field of USAGE_FIELDS) {
    total[field] = Math.max(usageNumber(usage[field]), usageNumber(counted[field]));
    delta[field] = total[field] - usageNumber(counted[field]);
  }
  if (!USAGE_FIELDS.some((field) => delta[field] > 0)) return false;
  writeChildRecord(childState, { usageCounted: total });
  await addUsage(delta);
  return true;
}

/** Counts a task engine's usage toward the run once: its run totals, each role's share, then marks it imported. */
async function importChild({ childState, stateDir, taskId, usage, addUsage, onEvent, addElevations = addRunElevations }) {
  if (readChildRecord(childState)?.usageImported) return;
  // Its final totals, or what it recorded so far when it ended without a report.
  await countChildUsage({ childState, usage: usage ?? readLiveUsage(childState), addUsage });
  // Its automatic Elevations count toward the run's limit, as its tokens do.
  try { addElevations(Number(JSON.parse(readFileSync(path.join(childState, "run-report.json"), "utf8"))?.elevations) || 0); } catch {}
  await importChildUsage({ childState, stateDir, taskId, onEvent }).catch(() => {});
  writeChildRecord(childState, { usageImported: true });
}

/** Whether a pid recorded in child.json is still that task engine: alive, started since this boot, and the same program. */
export async function engineAlive(pid, startedAt) {
  try { process.kill(pid, 0); } catch (error) { if (error.code !== "EPERM") return false; }
  // A pid from before the last boot belongs to some other process now.
  if (Date.parse(startedAt) < Date.now() - os.uptime() * 1000) return false;
  if (process.platform !== "win32") return true;
  const { stdout } = await exec("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { windowsHide: true, timeout: 10_000 }).catch(() => ({ stdout: "" }));
  return stdout.toLowerCase().includes(path.basename(process.execPath).toLowerCase());
}

async function killEngine(pid) {
  if (process.platform === "win32") await exec("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 10_000 });
  else process.kill(pid, "SIGTERM");
}

/**
 * Task engines a crashed run left behind (child.json with a live pid and no end): each gets Stop, then up to
 * waitMs to reach its safe point, and is ended if it has not. A new round never starts beside them.
 * Returns the state folders of the engines found.
 */
export async function stopOrphanChildren({ stateDir, waitMs = 60_000, pollMs = 1000, isAlive = engineAlive, kill = killEngine }) {
  const root = path.join(stateDir, "parallel");
  const found = [];
  for (const name of await readdir(root).catch(() => [])) {
    const dir = path.join(root, name);
    const record = readChildRecord(dir);
    if (!Number.isInteger(record?.pid) || record.exitedAt || record.parentPid === process.pid) continue;
    if (await isAlive(record.pid, record.startedAt)) found.push({ dir, ...record });
    else writeChildRecord(dir, { exitedAt: new Date().toISOString() });
  }
  if (!found.length) return [];
  await forwardStop(found.map((f) => f.dir));
  const deadline = Date.now() + waitMs;
  for (;;) {
    const alive = [];
    for (const f of found) if (await isAlive(f.pid, f.startedAt)) alive.push(f);
    if (!alive.length) break;
    if (Date.now() >= deadline) { for (const f of alive) await kill(f.pid).catch(() => {}); break; }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  for (const f of found) writeChildRecord(f.dir, { exitedAt: new Date().toISOString(), orphaned: true });
  return found.map((f) => f.dir);
}

/** Usage of task engines whose run ended before it could count it (a crash, a kill): counted now, once. */
export async function importLeftoverUsage({ stateDir, addUsage, onEvent, addElevations = addRunElevations }) {
  const root = path.join(stateDir, "parallel");
  for (const name of await readdir(root).catch(() => [])) {
    const dir = path.join(root, name);
    const record = readChildRecord(dir);
    // Only engines this version started and recorded, so the state of earlier runs is never counted twice.
    if (!Number.isInteger(record?.pid) || record.usageImported || !record.exitedAt) continue;
    const read = (file) => { try { return JSON.parse(readFileSync(path.join(dir, file), "utf8")); } catch { return null; } };
    await importChild({ childState: dir, stateDir, taskId: read("task.json")?.id ?? name, usage: read("run-report.json")?.usage ?? null, addUsage, onEvent, addElevations });
  }
}

/** Paths (from the repository root) that differ from HEAD, untracked ones included. */
async function dirtyPaths(top) {
  const { stdout } = await exec("git", ["-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"], { cwd: top, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  return stdout.split("\0").filter(Boolean).map((entry) => entry.slice(3));
}

/** Puts each path back as HEAD has it: checked out from HEAD, or removed when HEAD has no such file. */
async function restorePaths(top, paths) {
  for (const file of new Set(paths)) {
    try { await git(top, ["--literal-pathspecs", "checkout", "HEAD", "--", file]); continue; } catch {}
    await git(top, ["--literal-pathspecs", "rm", "-q", "--cached", "--force", "--ignore-unmatch", "--", file]).catch(() => {});
    try { rmSync(path.join(top, file), { force: true }); } catch {}
  }
}

/**
 * After a failed merge, puts back the commit's own paths when the rollback left them. Nothing else is touched:
 * a file that changed while the check ran may be yours, so it is reported, never restored or deleted.
 * Returns the paths cleaned and those still differing from HEAD.
 */
async function restoreToHead(workspace, commit = null) {
  const top = await git(workspace, ["rev-parse", "--show-toplevel"]);
  const before = await dirtyPaths(top);
  if (!before.length) return { cleaned: [], left: [] };
  if (commit) {
    const changed = await exec("git", ["-c", "core.fsmonitor=false", "diff-tree", "-r", "-z", "--no-commit-id", "--name-only", "--no-renames", commit], { cwd: top, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }).then((r) => r.stdout.split("\0").filter(Boolean), () => []);
    await restorePaths(top, changed);
  }
  const left = await dirtyPaths(top);
  return { cleaned: before.filter((p) => !left.includes(p)), left };
}

/** Default check runner: the task's approved check command in the project, through the QA runner (the same
 *  command check, and no secrets in its environment). A command it refuses, or that cannot start, fails the check. */
/** The combined check of a merge: a check that hangs (a watch mode, a server left running) fails after this. */
export const MERGE_CHECK_TIMEOUT_MS = 30 * 60_000;

export async function defaultRunCheck(command, cwd, { stateDir, timeoutMs = MERGE_CHECK_TIMEOUT_MS } = {}) {
  try {
    const { exitCode, output } = await runCheckCommand(command, cwd, { stateDir, timeoutMs });
    return { exitCode, output: String(output ?? "").slice(-4000) };
  } catch (error) { return { exitCode: 1, output: String(error?.message ?? error) }; }
}

/** Between rounds, as the normal loop between tasks: waits while paused; false once Stop arrives. */
async function beforeRound({ readControl, onEvent, pollMs }) {
  let announced = false;
  for (;;) {
    const control = await readControl();
    if (control.stopAfterSafePoint) { await onEvent({ type: "stopped" }); return false; }
    if (!control.pauseAfterCurrent) return true;
    if (!announced) { await onEvent({ type: "paused" }); announced = true; }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

export async function runParallel({ workspace, stateDir, objective, lanes, assess, runChild, runCheck = defaultRunCheck, onEvent, readControl, betweenTasks = async () => {}, onMerged = async () => {}, addUsage = addRunUsage, pollMs = 3000, onChildActivity = async () => {}, stopOrphans = stopOrphanChildren, maxRounds = 0, elevations = elevationBudget, addElevations = addRunElevations }) {
  let previous = null;
  const mergeFailures = new Map();
  // As the normal loop's block() and correction limit: the ending is recorded (Activity, notifications, Overview) before the run returns.
  const end = async (status, output) => { await onEvent({ type: status, qa: output }); return { status, output }; };
  for (let round = 1; ; round++) {
    // --max-rounds: the run ends between rounds once that many have run, as Stop would.
    if (maxRounds && round > maxRounds) {
      await onEvent({ type: "stopped" });
      return { status: "stopped", output: `Round limit reached: ${maxRounds} parallel round${maxRounds === 1 ? "" : "s"}.${previous ? ` ${previous.result}` : ""}` };
    }
    if (!(await beforeRound({ readControl, onEvent, pollMs }))) return { status: "stopped", ...(previous ? { output: previous.result } : {}) };
    // Task engines a crashed run left at work end first, and their usage counts; then the round can start.
    const orphans = await stopOrphans({ stateDir });
    if (orphans.length) await onEvent({ type: "parallel-orphans-stopped", count: orphans.length, folders: orphans.map((dir) => path.basename(dir)) });
    await importLeftoverUsage({ stateDir, addUsage, onEvent, addElevations }).catch(() => {});
    await betweenTasks();
    if (await git(workspace, ["status", "--porcelain", "--untracked-files=all"])) return end("blocked", "Parallel tasks need a clean working tree between rounds.");
    const head = await git(workspace, ["rev-parse", "HEAD"]);
    const batch = [];
    let done = false, qaRejections = 0;
    // The Task board order, read once: every task of this round is chosen against the same priority.
    const priority = await taskPrioritySection({ workspace, stateDir });
    while (batch.length < lanes) {
      const taken = batch.map((t) => `${t.id} "${t.name ?? t.id}" (files: ${t.allowedPaths.join(", ")})`).join("; ");
      const text = (await objectiveWithDeferred(stateDir, objective)) + (priority ? `\n\n${priority}` : "") + (taken ? `\n\nAlready running in parallel this round: ${taken}. Choose a different task whose allowedPaths share no file or folder with these, or return done when no such task remains.` : "");
      const result = await assess({ objective: text, previous });
      if (result.status === "done") { done = !batch.length; break; }
      if (result.status !== "task") { if (!batch.length) return end("blocked", result.output ?? "Assessment could not produce a safe task"); break; }
      const task = result.task;
      try { validateTask(task); }
      catch (error) { if (!batch.length) return end("blocked", error.message); break; }
      // As in the normal loop: an unapproved check command sends Assessment back once, with the reason.
      try { assertSafeQaCommand({ workspace, stateDir, command: task.qaCommand }); qaRejections = 0; }
      catch (error) {
        if (++qaRejections > 1) { if (!batch.length) return end("blocked", `${error.message}: ${task.qaCommand}`); break; }
        await onEvent({ type: "assessment-rejected", qa: `Check command "${task.qaCommand}" is not allowed. Assessment chooses again.` });
        previous = { task, result: `Rejected before implementation: qaCommand "${task.qaCommand}" is not an approved check. Use an existing npm script (npm test, npm run <script>) or npx tsc/eslint/prettier/vitest/playwright.` };
        continue;
      }
      if (batch.some((t) => t.id === task.id || overlaps(t, task))) break;
      batch.push(task);
    }
    if (done) { await onEvent({ type: "loop-complete" }); return { status: "done" }; }
    await onEvent({ type: "parallel-round", round, tasks: batch.map((t) => ({ id: t.id, name: t.name ?? t.id })) });
    // parallel-round.json: the round's tasks and where each one is, for Overview's live view of the round.
    let roundInfo = { round, startedAt: new Date().toISOString(), endedAt: null, tasks: batch.map((t) => ({ id: t.id, name: t.name ?? t.id, status: "starting" })) }, roundWrite = Promise.resolve();
    const saveRound = (fields) => {
      roundInfo = { ...roundInfo, ...fields };
      const snapshot = roundInfo;
      roundWrite = roundWrite.then(() => atomicWriteJson(path.join(stateDir, ROUND_FILE), snapshot)).catch(() => {});
      return roundWrite;
    };
    const saveTask = (id, fields) => saveRound({ tasks: roundInfo.tasks.map((t) => (t.id === id ? { ...t, ...fields } : t)) });
    const endRound = () => saveRound({ endedAt: new Date().toISOString() });
    await saveRound({});

    // Stop, Pause and Resume reach the running tasks: each task's engine stops (or pauses) at its own next safe point.
    // Resume also ends a task's usage-limit wait, which waits for a Resume of its own engine.
    const children = [];
    let forwarded = false, paused = false, ticking = false, limitWait = false;
    let resumes = Number((await readControl().catch(() => ({}))).resumeGeneration ?? 0);
    const stopAll = async () => { if (!forwarded) { forwarded = true; await forwardStop(children.map((c) => c.state)); } };
    // The run's stage leaves WAITING_FOR_LIMIT once no task waits any more (and at the latest when the round ends).
    const clearLimitWait = async () => { if (limitWait) { limitWait = false; await onEvent({ type: "parallel-limit-cleared", parallel: true }); } };
    const watch = setInterval(async () => {
      if (forwarded || ticking) return;
      ticking = true;
      try {
        const control = await readControl().catch(() => ({}));
        if (control.stopAfterSafePoint) return await stopAll();
        const states = children.map((c) => c.state);
        if (Number(control.resumeGeneration ?? 0) > resumes) { resumes = Number(control.resumeGeneration); paused = false; await forwardControl(states, "resume"); }
        if (Boolean(control.pauseAfterCurrent) !== paused) { paused = !paused; await forwardControl(states, paused ? "pause" : "resume"); }
        // One budget for the run: each task's usage so far counts now, and a run or day limit it reaches (the
        // run asks itself to stop) stops every task at its next safe point.
        let used = false;
        for (const child of children) if (await countChildUsage({ childState: child.dir, usage: readLiveUsage(child.dir), addUsage }).catch(() => false)) used = true;
        if (used && (await readControl().catch(() => ({}))).stopAfterSafePoint) return await stopAll();
        // A task waiting out a usage limit holds up the round: say so once per wait.
        let active = false;
        for (const child of children) {
          const live = await child.state.readLive().catch(() => null);
          const waiting = live?.stage === "WAITING_FOR_LIMIT";
          if (waiting && !child.waiting) { limitWait = true; await onEvent({ type: "waiting-for-codex", taskId: child.taskId, parallel: true, operation: live.interruptedOperation ?? null, message: live.codexLimitMessage ?? null, retryAt: live.codexRetryAt ?? null }); }
          child.waiting = waiting;
          // A task engine that records anything is at work: the run's Supervisor counts that as activity of the run.
          const mark = `${live?.updatedAt ?? ""}|${(await stat(child.state.activityPath).catch(() => null))?.mtimeMs ?? ""}`;
          if (mark !== "|" && mark !== child.mark) active = true;
          child.mark = mark;
        }
        if (!children.some((c) => c.waiting)) await clearLimitWait();
        if (active) await onChildActivity();
      } finally { ticking = false; }
    }, pollMs);
    // One name per run and try, so a worktree kept from an earlier run never blocks this one.
    const stamp = Date.now().toString(36);
    const taken = new Set();
    const allowance = shareElevations(elevations(), batch.length);
    // git worktree add, one at a time: concurrent adds race on the repository's worktree files.
    let creating = Promise.resolve();
    const settled = await Promise.allSettled(batch.map(async (task, index) => {
      const id = String(task.id).replace(/[^\w.-]+/g, "_");
      const worktree = freeWorktree(workspace, `${id}-${stamp}`, taken);
      const branch = `agent-dock/parallel-${path.basename(worktree)}`;
      const childState = path.join(stateDir, "parallel", path.basename(worktree));
      mkdirSync(childState, { recursive: true });
      // One DashboardState per task engine for the round, so control writes to it queue one after another.
      children.push({ taskId: task.id, dir: childState, state: new DashboardState({ stateDir: childState }), waiting: false });
      // A task that cannot start stops the ones that did; the round reports once they have all ended.
      const created = creating.then(() => git(workspace, ["worktree", "add", "-b", branch, worktree, head]));
      creating = created.catch(() => {});
      try { await created; }
      catch (error) {
        // No orphan branch is left behind by a worktree that was not made.
        await git(workspace, ["worktree", "prune"]).catch(() => {});
        await git(workspace, ["branch", "-D", branch]).catch(() => {});
        await stopAll();
        throw error;
      }
      // Ignored dependencies are not in a new worktree; link the project's node_modules so checks can run.
      const modules = path.join(workspace, "node_modules");
      if (existsSync(modules) && !existsSync(path.join(worktree, "node_modules"))) { try { symlinkSync(modules, path.join(worktree, "node_modules"), "junction"); } catch {} }
      const taskFile = path.join(childState, "task.json");
      await atomicWriteJson(taskFile, task);
      await onEvent({ type: "parallel-task-started", taskId: task.id, name: task.name ?? task.id, branch, worktree });
      await saveTask(task.id, { status: "running", folder: path.basename(childState), branch, startedAt: new Date().toISOString() });
      const result = await runChild({ task, worktree, stateDir: childState, taskFile, elevations: allowance[index] });
      await saveTask(task.id, { status: result.status === "passed" && result.commit ? "approved" : result.status === "stopped" ? "stopped" : "failed", endedAt: new Date().toISOString() });
      // Whatever the result: the task's tokens and spend count toward this run (its engine kept them in its own
      // state folder), and each role's share, which Overview reads from the run's own state folder.
      await importChild({ childState, stateDir, taskId: task.id, usage: result.usage, addUsage, onEvent, addElevations });
      // With its attempts and how it ended (summary, not qa: the round's own latest outcome stays), so Task history lists a task that did not pass as well.
      await onEvent({ type: "parallel-task-finished", taskId: task.id, status: result.status, commit: result.commit ?? null, branch, ...(Number.isInteger(result.attempts) ? { attempt: result.attempts } : {}), ...(result.output ? { summary: firstLine(result.output, 300) } : {}) });
      return { task, worktree, branch, childState, result };
    })).finally(() => clearInterval(watch));
    // The interval may still be inside a tick: let it finish before the round reports, so no wait is announced after it.
    while (ticking) await new Promise((r) => setTimeout(r, 5));
    await clearLimitWait();
    const runs = settled.map((s, i) => (s.status === "fulfilled" ? s.value : { task: batch[i], startError: firstLine(s.reason?.message ?? s.reason, 300) }));
    for (const run of runs) if (run.startError) await saveTask(run.task.id, { status: "failed" });

    const notes = [], cleanups = [];
    for (const [index, run] of runs.entries()) {
      const { task, worktree, branch, result } = run;
      if (run.startError) { notes.push(`${task.id} could not start: ${run.startError}`); continue; }
      // A task its engine set aside is listed for the run's Assessment too (one at a time: one list file).
      await mergeDeferred(run.childState, stateDir).catch(() => {});
      if (result.status !== "passed" || !result.commit) { notes.push(`${task.id}: ${result.status}${result.output ? ` (${firstLine(result.output, 200)})` : ""}; its worktree stays at ${worktree}`); continue; }
      let merged = false, why = "";
      try { await git(workspace, ["cherry-pick", "--no-commit", result.commit]); }
      catch (error) { why = `did not apply cleanly to the combined code (${firstLine(error.message, 200)})`; }
      if (!why) {
        const check = await runCheck(task.qaCommand, workspace, { stateDir });
        if (check.exitCode === 0) {
          // A pre-commit hook that refuses it, or a change already on your branch (nothing to commit), is a merge that failed.
          try { await git(workspace, ["commit", "--no-edit", "-C", result.commit]); merged = true; }
          catch (error) { why = `could not be committed on the combined code (${firstLine(String(error.stderr ?? "").trim() || String(error.stdout ?? "").trim() || error.message, 200)})`; }
        } else why = `its check failed on the combined code: ${String(check.output).trim().split(/\r?\n/).slice(-3).join(" ").slice(0, 300)}`;
      }
      if (!merged) {
        // The change stays on its branch; your branch is back where it was.
        await git(workspace, ["reset", "--merge"]).catch(() => {});
        await git(workspace, ["cherry-pick", "--quit"]).catch(() => {});
      }
      // What a failed rollback left of the change is undone; any other file that differs from HEAD stops the round.
      const restored = await restoreToHead(workspace, merged ? null : result.commit).catch((error) => ({ cleaned: [], left: [`(${firstLine(error.message, 200)})`] }));
      if (restored.cleaned.length) cleanups.push(`${task.id}: restored ${restored.cleaned.length === 1 ? "1 file" : `${restored.cleaned.length} files`} left after its merge (${restored.cleaned.slice(0, 5).join(", ")}${restored.cleaned.length > 5 ? ", ..." : ""})`);
      if (!merged) {
        notes.push(`${task.id} ${why}; kept on branch ${branch}`);
        mergeFailures.set(task.id, (mergeFailures.get(task.id) ?? 0) + 1);
        await saveTask(task.id, { status: "merge-failed" });
        await onEvent({ type: "parallel-merge-failed", taskId: task.id, branch, message: why, ...(Number.isInteger(result.attempts) ? { attempt: result.attempts } : {}) });
      } else {
        await saveTask(task.id, { status: "merged" });
        const commit = await git(workspace, ["rev-parse", "HEAD"]);
        await onEvent({ type: "parallel-merged", taskId: task.id, commit, branch });
        await onEvent({ type: "qa-pass", taskId: task.id, qa: `Merged from ${branch}`, parallel: true, ...(Number.isInteger(result.attempts) ? { attempt: result.attempts } : {}), ...(task.planItems?.length ? { planItems: task.planItems } : {}) });
        await onMerged(task);
        await removeWorktree(workspace, worktree).catch(() => {});
        await git(workspace, ["branch", "-D", branch]).catch(() => {});
      }
      if (restored.left.length) {
        // Nothing more is merged onto a tree that is not clean: the remaining approved tasks stay on their branches.
        const rest = runs.slice(index + 1).filter((r) => !r.startError && r.result.status === "passed" && r.result.commit).map((r) => `${r.task.id} (branch ${r.branch})`);
        await endRound();
        return end("user-attention", `Parallel round ${round}: after ${merged ? "merging" : "rolling back"} ${task.id}, the working tree still differs from HEAD in ${restored.left.slice(0, 10).join(", ")}${restored.left.length > 10 ? ", ..." : ""}, which Agent Dock leaves alone (a check that writes files, or your own edits). Check and clean the working tree, then Run again.${rest.length ? ` Not merged yet: ${rest.join(", ")}.` : ""}${notes.length ? ` ${notes.join("; ")}` : ""}`);
      }
    }
    await endRound();
    const summary = notes.length ? `Parallel round ${round}: ${notes.join("; ")}` : `Parallel round ${round}: ${batch.length === 1 ? "its task" : `all ${batch.length} tasks`} merged.`;
    previous = { task: batch.at(-1), result: cleanups.length ? `${summary} ${cleanups.join("; ")}.` : summary };
    if (runs.some((r) => r.startError)) return end("blocked", previous.result);
    if ((await readControl()).stopAfterSafePoint) { await onEvent({ type: "stopped" }); return { status: "stopped", output: previous.result }; }
    // Nothing merged and nothing left to try: stop for you instead of repeating the same round.
    if (notes.length === runs.length) return end("user-attention", previous.result);
    // Nor pick the same change again after it failed to merge twice.
    const repeated = [...mergeFailures].filter(([, n]) => n >= 2).map(([id]) => id);
    if (repeated.length) return end("user-attention", `${repeated.join(", ")} failed to merge twice. ${previous.result}`);
  }
}

/** Forwards a control action (stop, pause, resume) to every running child engine (DashboardStates or state folders). */
export async function forwardControl(targets, action) {
  for (const target of targets) await (typeof target === "string" ? new DashboardState({ stateDir: target }) : target).setControl(action).catch(() => {});
}

/** Forwards a Stop to every running child engine. */
export const forwardStop = (targets) => forwardControl(targets, "stop");
