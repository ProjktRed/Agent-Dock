import { execFile, spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmdirSync, symlinkSync, unlinkSync } from "node:fs";
import { mkdir, readdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { atomicWriteJson, DashboardState } from "./dashboard-state.mjs";
import { mergeDeferred, objectiveWithDeferred } from "./defer-task.mjs";
import { assertSafeQaCommand } from "./guard/protected-paths.mjs";
import { noteStepDownApproval } from "./engine-tuning.mjs";
import { validateTask } from "./node-loop.mjs";
import { addRunUsage } from "./run-budget.mjs";

// Parallel tasks in one run (0.35, --parallel N). Each round, Assessment picks up to N tasks whose
// allowed files do not overlap. Every task then runs through a complete engine of its own (Implementation,
// QA, its commit) in a git worktree next to the project, on its own branch, at the same time. The run then
// brings each approved commit into your branch one by one: it applies the change without committing,
// runs that task's check command on the combined code, and commits only if the check passes. A change
// that does not apply or fails its check is not committed; its branch is kept for you and the work
// goes back to Assessment. Worktrees of tasks that did not finish are left in place to inspect.
// Between rounds the run follows Stop and Pause as the normal loop does between tasks (Automatic
// continuation off pauses after a round that merged a change). A task that fails to merge twice stops for you.

const exec = promisify(execFile);
const git = (cwd, args) => exec("git", args, { cwd, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }).then((r) => r.stdout.trim());
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

/** Child engine arguments: the parent's, for one task in its worktree with its own state folder.
 *  No step-down in a task's engine: the parent plans the next round. sizing (the parent's tuning while it is
 *  stepped down) replaces the configured task size, so the task's engine works at the size it was planned for. */
export function childArgs(argv, { worktree, stateDir, taskFile, sizing = null }) {
  const drop = new Set(["--workspace", "--state-dir", "--task", "--parallel", "--single-task", "--auto-continue", "--step-down", ...(sizing ? SIZE_FLAGS : [])]);
  const out = [];
  for (let i = 0; i < argv.length; i += 2) if (!drop.has(argv[i])) out.push(argv[i], argv[i + 1]);
  const size = sizing ? ["--task-mode", sizing.taskMode, "--task-max-files", String(sizing.taskMaxFiles), "--task-max-new-lines", String(sizing.taskMaxNewLines), "--task-max-read-files", String(sizing.taskMaxReadFiles)] : [];
  return [...out, ...size, "--workspace", worktree, "--state-dir", stateDir, "--task", taskFile, "--single-task", "true", "--auto-continue", "true", "--step-down", "false"];
}

/** onMerged for a run: a merged task counts toward ending a step-down, as an approved task does in the normal loop. */
export const endStepDown = (onEvent) => async (task) => {
  const restored = noteStepDownApproval(task);
  if (restored) await onEvent({ type: "task-mode-restored", mode: restored.mode, from: restored.from });
};

/** Runs one child engine to the end of its task; resolves with its loop result, approved commit and usage. */
export function spawnChildEngine({ cliPath, args, stateDir, env = process.env }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], { env, windowsHide: true, stdio: "ignore" });
    child.on("error", (error) => resolve({ status: "blocked", output: error.message }));
    child.on("close", () => {
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

/** Default check runner: the task's approved check command in the project, as QA runs it. */
async function defaultRunCheck(command, cwd) {
  const shell = process.platform === "win32" ? "powershell.exe" : "/bin/sh";
  const args = process.platform === "win32" ? ["-NoProfile", "-NonInteractive", "-Command", command] : ["-c", command];
  return new Promise((resolve) => {
    let output = "";
    const child = spawn(shell, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (c) => (output += c));
    child.stderr.on("data", (c) => (output += c));
    child.on("error", (error) => resolve({ exitCode: 1, output: error.message }));
    child.on("close", (exitCode) => resolve({ exitCode: exitCode ?? 1, output: output.slice(-4000) }));
  });
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

export async function runParallel({ workspace, stateDir, objective, lanes, assess, runChild, runCheck = defaultRunCheck, onEvent, readControl, betweenTasks = async () => {}, onMerged = async () => {}, addUsage = addRunUsage, pollMs = 3000 }) {
  let previous = null;
  const mergeFailures = new Map();
  for (let round = 1; ; round++) {
    if (!(await beforeRound({ readControl, onEvent, pollMs }))) return { status: "stopped", ...(previous ? { output: previous.result } : {}) };
    await betweenTasks();
    if (await git(workspace, ["status", "--porcelain", "--untracked-files=all"])) return { status: "blocked", output: "Parallel tasks need a clean working tree between rounds." };
    const head = await git(workspace, ["rev-parse", "HEAD"]);
    const batch = [];
    let done = false, qaRejections = 0;
    while (batch.length < lanes) {
      const taken = batch.map((t) => `${t.id} "${t.name ?? t.id}" (files: ${t.allowedPaths.join(", ")})`).join("; ");
      const text = (await objectiveWithDeferred(stateDir, objective)) + (taken ? `\n\nAlready running in parallel this round: ${taken}. Choose a different task whose allowedPaths share no file or folder with these, or return done when no such task remains.` : "");
      const result = await assess({ objective: text, previous });
      if (result.status === "done") { done = !batch.length; break; }
      if (result.status !== "task") { if (!batch.length) return { status: "blocked", output: result.output ?? "Assessment could not produce a safe task" }; break; }
      const task = result.task;
      try { validateTask(task); }
      catch (error) { if (!batch.length) return { status: "blocked", output: error.message }; break; }
      // As in the normal loop: an unapproved check command sends Assessment back once, with the reason.
      try { assertSafeQaCommand({ workspace, stateDir, command: task.qaCommand }); qaRejections = 0; }
      catch (error) {
        if (++qaRejections > 1) { if (!batch.length) return { status: "blocked", output: `${error.message}: ${task.qaCommand}` }; break; }
        await onEvent({ type: "assessment-rejected", qa: `Check command "${task.qaCommand}" is not allowed. Assessment chooses again.` });
        previous = { task, result: `Rejected before implementation: qaCommand "${task.qaCommand}" is not an approved check. Use an existing npm script (npm test, npm run <script>) or npx tsc/eslint/prettier/vitest/playwright.` };
        continue;
      }
      if (batch.some((t) => t.id === task.id || overlaps(t, task))) break;
      batch.push(task);
    }
    if (done) { await onEvent({ type: "loop-complete" }); return { status: "done" }; }
    await onEvent({ type: "parallel-round", round, tasks: batch.map((t) => ({ id: t.id, name: t.name ?? t.id })) });

    // Stop, Pause and Resume reach the running tasks: each task's engine stops (or pauses) at its own next safe point.
    // Resume also ends a task's usage-limit wait, which waits for a Resume of its own engine.
    const children = [];
    let forwarded = false, paused = false, ticking = false;
    let resumes = Number((await readControl().catch(() => ({}))).resumeGeneration ?? 0);
    const stopAll = async () => { if (!forwarded) { forwarded = true; await forwardStop(children.map((c) => c.state)); } };
    const watch = setInterval(async () => {
      if (forwarded || ticking) return;
      ticking = true;
      try {
        const control = await readControl().catch(() => ({}));
        if (control.stopAfterSafePoint) return await stopAll();
        const states = children.map((c) => c.state);
        if (Number(control.resumeGeneration ?? 0) > resumes) { resumes = Number(control.resumeGeneration); paused = false; await forwardControl(states, "resume"); }
        if (Boolean(control.pauseAfterCurrent) !== paused) { paused = !paused; await forwardControl(states, paused ? "pause" : "resume"); }
        // A task waiting out a usage limit holds up the round: say so once per wait.
        for (const child of children) {
          const live = await child.state.readLive().catch(() => null);
          const waiting = live?.stage === "WAITING_FOR_LIMIT";
          if (waiting && !child.waiting) await onEvent({ type: "waiting-for-codex", taskId: child.taskId, parallel: true, operation: live.interruptedOperation ?? null, message: live.codexLimitMessage ?? null, retryAt: live.codexRetryAt ?? null });
          child.waiting = waiting;
        }
      } finally { ticking = false; }
    }, pollMs);
    // One name per run and try, so a worktree kept from an earlier run never blocks this one.
    const stamp = Date.now().toString(36);
    const taken = new Set();
    const settled = await Promise.allSettled(batch.map(async (task) => {
      const id = String(task.id).replace(/[^\w.-]+/g, "_");
      const worktree = freeWorktree(workspace, `${id}-${stamp}`, taken);
      const branch = `agent-dock/parallel-${path.basename(worktree)}`;
      const childState = path.join(stateDir, "parallel", path.basename(worktree));
      mkdirSync(childState, { recursive: true });
      // One DashboardState per task engine for the round, so control writes to it queue one after another.
      children.push({ taskId: task.id, state: new DashboardState({ stateDir: childState }), waiting: false });
      // A task that cannot start stops the ones that did; the round reports once they have all ended.
      try { await git(workspace, ["worktree", "add", "-b", branch, worktree, head]); }
      catch (error) { await stopAll(); throw error; }
      // Ignored dependencies are not in a new worktree; link the project's node_modules so checks can run.
      const modules = path.join(workspace, "node_modules");
      if (existsSync(modules) && !existsSync(path.join(worktree, "node_modules"))) { try { symlinkSync(modules, path.join(worktree, "node_modules"), "junction"); } catch {} }
      const taskFile = path.join(childState, "task.json");
      await atomicWriteJson(taskFile, task);
      await onEvent({ type: "parallel-task-started", taskId: task.id, name: task.name ?? task.id, branch, worktree });
      const result = await runChild({ task, worktree, stateDir: childState, taskFile });
      // The task's tokens and spend count toward this run: its engine kept them in its own state folder.
      if (result.usage) await addUsage(result.usage);
      // And each role's share, which Overview reads from the run's own state folder.
      await importChildUsage({ childState, stateDir, taskId: task.id, onEvent }).catch(() => {});
      await onEvent({ type: "parallel-task-finished", taskId: task.id, status: result.status, commit: result.commit ?? null, branch });
      return { task, worktree, branch, childState, result };
    })).finally(() => clearInterval(watch));
    const runs = settled.map((s, i) => (s.status === "fulfilled" ? s.value : { task: batch[i], startError: firstLine(s.reason?.message ?? s.reason, 300) }));

    const notes = [];
    for (const run of runs) {
      const { task, worktree, branch, result } = run;
      if (run.startError) { notes.push(`${task.id} could not start: ${run.startError}`); continue; }
      // A task its engine set aside is listed for the run's Assessment too (one at a time: one list file).
      await mergeDeferred(run.childState, stateDir).catch(() => {});
      if (result.status !== "passed" || !result.commit) { notes.push(`${task.id}: ${result.status}${result.output ? ` (${firstLine(result.output, 200)})` : ""}; its worktree stays at ${worktree}`); continue; }
      let merged = false, why = "";
      try { await git(workspace, ["cherry-pick", "--no-commit", result.commit]); }
      catch (error) { why = `did not apply cleanly to the combined code (${firstLine(error.message, 200)})`; }
      if (!why) {
        const check = await runCheck(task.qaCommand, workspace);
        if (check.exitCode === 0) {
          await git(workspace, ["commit", "--no-edit", "-C", result.commit]);
          merged = true;
        } else why = `its check failed on the combined code: ${String(check.output).trim().split(/\r?\n/).slice(-3).join(" ").slice(0, 300)}`;
      }
      if (!merged) {
        // The change stays on its branch; your branch is back where it was.
        await git(workspace, ["reset", "--merge"]).catch(() => {});
        await git(workspace, ["cherry-pick", "--quit"]).catch(() => {});
        notes.push(`${task.id} ${why}; kept on branch ${branch}`);
        mergeFailures.set(task.id, (mergeFailures.get(task.id) ?? 0) + 1);
        await onEvent({ type: "parallel-merge-failed", taskId: task.id, branch, message: why });
        continue;
      }
      const commit = await git(workspace, ["rev-parse", "HEAD"]);
      await onEvent({ type: "parallel-merged", taskId: task.id, commit, branch });
      await onEvent({ type: "qa-pass", taskId: task.id, qa: `Merged from ${branch}`, parallel: true, ...(Number.isInteger(result.attempts) ? { attempt: result.attempts } : {}), ...(task.planItems?.length ? { planItems: task.planItems } : {}) });
      await onMerged(task);
      await removeWorktree(workspace, worktree).catch(() => {});
      await git(workspace, ["branch", "-D", branch]).catch(() => {});
    }
    previous = { task: batch.at(-1), result: notes.length ? `Parallel round ${round}: ${notes.join("; ")}` : `Parallel round ${round}: ${batch.length === 1 ? "its task" : `all ${batch.length} tasks`} merged.` };
    if (runs.some((r) => r.startError)) return { status: "blocked", output: previous.result };
    if ((await readControl()).stopAfterSafePoint) { await onEvent({ type: "stopped" }); return { status: "stopped", output: previous.result }; }
    // Nothing merged and nothing left to try: stop for you instead of repeating the same round.
    if (notes.length === runs.length) return { status: "user-attention", output: previous.result };
    // Nor pick the same change again after it failed to merge twice.
    const repeated = [...mergeFailures].filter(([, n]) => n >= 2).map(([id]) => id);
    if (repeated.length) return { status: "user-attention", output: `${repeated.join(", ")} failed to merge twice. ${previous.result}` };
  }
}

/** Forwards a control action (stop, pause, resume) to every running child engine (DashboardStates or state folders). */
export async function forwardControl(targets, action) {
  for (const target of targets) await (typeof target === "string" ? new DashboardState({ stateDir: target }) : target).setControl(action).catch(() => {});
}

/** Forwards a Stop to every running child engine. */
export const forwardStop = (targets) => forwardControl(targets, "stop");
