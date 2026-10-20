import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { atomicWriteJson, DashboardState } from "./dashboard-state.mjs";
import { objectiveWithDeferred } from "./defer-task.mjs";
import { assertSafeQaCommand } from "./guard/protected-paths.mjs";
import { validateTask } from "./node-loop.mjs";

// Parallel tasks in one run (0.35, --parallel N). Each round, Assessment picks up to N tasks whose
// allowed files do not overlap. Every task then runs through a complete engine of its own (Implementation,
// QA, its commit) in a git worktree next to the project, on its own branch, at the same time. The run then
// brings each approved commit into your branch one by one: it applies the change without committing,
// runs that task's check command on the combined code, and commits only if the check passes. A change
// that does not apply or fails its check is not committed; its branch is kept for you and the work
// goes back to Assessment. Worktrees of tasks that did not finish are left in place to inspect.

const exec = promisify(execFile);
const git = (cwd, args) => exec("git", args, { cwd, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }).then((r) => r.stdout.trim());

const overlaps = (a, b) => a.allowedPaths.some((x) => b.allowedPaths.some((y) => x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`)));

/** The worktree folder for a task: next to the project, like parallel lanes. */
export const worktreeFor = (workspace, taskId) => path.join(path.dirname(workspace), `${path.basename(workspace)}-parallel`, String(taskId).replace(/[^\w.-]+/g, "_"));

/** Child engine arguments: the parent's, for one task in its worktree with its own state folder. */
export function childArgs(argv, { worktree, stateDir, taskFile }) {
  const drop = new Set(["--workspace", "--state-dir", "--task", "--parallel", "--single-task", "--auto-continue"]);
  const out = [];
  for (let i = 0; i < argv.length; i += 2) if (!drop.has(argv[i])) out.push(argv[i], argv[i + 1]);
  return [...out, "--workspace", worktree, "--state-dir", stateDir, "--task", taskFile, "--single-task", "true", "--auto-continue", "true"];
}

/** Runs one child engine to the end of its task; resolves with its loop result and approved commit. */
export function spawnChildEngine({ cliPath, args, stateDir, env = process.env }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], { env, windowsHide: true, stdio: "ignore" });
    child.on("error", (error) => resolve({ status: "blocked", output: error.message }));
    child.on("close", () => {
      const read = (name) => { try { return JSON.parse(readFileSync(path.join(stateDir, name), "utf8")); } catch { return null; } };
      const result = read("loop-result.json") ?? { status: "blocked", output: "The task's engine ended without a result." };
      resolve({ ...result, commit: read("last-result.json")?.result?.qa?.commit ?? null });
    });
  });
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

export async function runParallel({ workspace, stateDir, objective, lanes, assess, runChild, runCheck = defaultRunCheck, onEvent, readControl, betweenTasks = async () => {}, onMerged = async () => {}, pollMs = 3000 }) {
  let previous = null;
  for (let round = 1; ; round++) {
    if ((await readControl()).stopAfterSafePoint) { await onEvent({ type: "stopped" }); return { status: "stopped" }; }
    await betweenTasks();
    if (await git(workspace, ["status", "--porcelain", "--untracked-files=all"])) return { status: "blocked", output: "Parallel tasks need a clean working tree between rounds." };
    const head = await git(workspace, ["rev-parse", "HEAD"]);
    const batch = [];
    let done = false;
    while (batch.length < lanes) {
      const taken = batch.map((t) => `${t.id} "${t.name ?? t.id}" (files: ${t.allowedPaths.join(", ")})`).join("; ");
      const text = (await objectiveWithDeferred(stateDir, objective)) + (taken ? `\n\nAlready running in parallel this round: ${taken}. Choose a different task whose allowedPaths share no file or folder with these, or return done when no such task remains.` : "");
      const result = await assess({ objective: text, previous });
      if (result.status === "done") { done = !batch.length; break; }
      if (result.status !== "task") { if (!batch.length) return { status: "blocked", output: result.output ?? "Assessment could not produce a safe task" }; break; }
      const task = result.task;
      try { validateTask(task); assertSafeQaCommand({ workspace, stateDir, command: task.qaCommand }); }
      catch (error) { if (!batch.length) return { status: "blocked", output: `${error.message}: ${task.qaCommand}` }; break; }
      if (batch.some((t) => t.id === task.id || overlaps(t, task))) break;
      batch.push(task);
    }
    if (done) { await onEvent({ type: "loop-complete" }); return { status: "done" }; }
    await onEvent({ type: "parallel-round", round, tasks: batch.map((t) => ({ id: t.id, name: t.name ?? t.id })) });

    // Stop reaches the running tasks: each task's engine stops at its own next safe point.
    const childStates = [];
    let forwarded = false;
    const watch = setInterval(async () => {
      if (forwarded || !(await readControl().catch(() => ({}))).stopAfterSafePoint) return;
      forwarded = true;
      await forwardStop(childStates);
    }, pollMs);
    const runs = await Promise.all(batch.map(async (task) => {
      const worktree = worktreeFor(workspace, `${task.id}-${round}`);
      const branch = `agent-dock/parallel-${String(task.id).replace(/[^\w.-]+/g, "_")}-${Date.now().toString(36)}`;
      const childState = path.join(stateDir, "parallel", path.basename(worktree));
      mkdirSync(childState, { recursive: true });
      childStates.push(childState);
      await git(workspace, ["worktree", "add", "-b", branch, worktree, head]);
      // Ignored dependencies are not in a new worktree; link the project's node_modules so checks can run.
      const modules = path.join(workspace, "node_modules");
      if (existsSync(modules) && !existsSync(path.join(worktree, "node_modules"))) { try { symlinkSync(modules, path.join(worktree, "node_modules"), "junction"); } catch {} }
      const taskFile = path.join(childState, "task.json");
      await atomicWriteJson(taskFile, task);
      await onEvent({ type: "parallel-task-started", taskId: task.id, name: task.name ?? task.id, branch, worktree });
      const result = await runChild({ task, worktree, stateDir: childState, taskFile });
      await onEvent({ type: "parallel-task-finished", taskId: task.id, status: result.status, commit: result.commit ?? null, branch });
      return { task, worktree, branch, childState, result };
    })).finally(() => clearInterval(watch));

    const notes = [];
    for (const run of runs) {
      const { task, worktree, branch, result } = run;
      if (result.status !== "passed" || !result.commit) { notes.push(`${task.id}: ${result.status}${result.output ? ` (${String(result.output).split(/\r?\n/)[0].slice(0, 200)})` : ""}; its worktree stays at ${worktree}`); continue; }
      let merged = false, why = "";
      try { await git(workspace, ["cherry-pick", "--no-commit", result.commit]); }
      catch (error) { why = `did not apply cleanly to the combined code (${String(error.message).split(/\r?\n/)[0].slice(0, 200)})`; }
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
        await onEvent({ type: "parallel-merge-failed", taskId: task.id, branch, message: why });
        continue;
      }
      const commit = await git(workspace, ["rev-parse", "HEAD"]);
      await onEvent({ type: "parallel-merged", taskId: task.id, commit, branch });
      await onEvent({ type: "qa-pass", taskId: task.id, qa: `Merged from ${branch}`, parallel: true, ...(task.planItems?.length ? { planItems: task.planItems } : {}) });
      await onMerged(task);
      await git(workspace, ["worktree", "remove", "--force", worktree]).catch(() => {});
      await git(workspace, ["branch", "-D", branch]).catch(() => {});
    }
    previous = { task: batch.at(-1), result: notes.length ? `Parallel round ${round}: ${notes.join("; ")}` : `Parallel round ${round}: all ${batch.length} task(s) merged.` };
    if ((await readControl()).stopAfterSafePoint) { await onEvent({ type: "stopped" }); return { status: "stopped", output: previous.result }; }
    // Nothing merged and nothing left to try: stop for you instead of repeating the same round.
    if (notes.length === runs.length) return { status: "user-attention", output: previous.result };
  }
}

/** Forwards a Stop to every running child engine. */
export async function forwardStop(stateDirs) {
  for (const dir of stateDirs) await new DashboardState({ stateDir: dir }).setControl("stop").catch(() => {});
}
