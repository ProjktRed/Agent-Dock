import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { clineHandoffSkill } from "./task-handoff-skill.mjs";
import { redactText } from "./redact.mjs";

/**
 * Deterministic CREATE / MODIFY status of each approved path, so the local worker
 * never spends its context searching for a file it is supposed to create.
 * Tracked = existed at the clean baseline; untracked but present = created by this task.
 */
export function describeAllowedPaths(task, workspace) {
  // The git call is synchronous; never spawn it for a workspace that is not a repository root
  // (`.git` is a directory, or a file in a worktree).
  if (!workspace || !task.allowedPaths?.length || !existsSync(path.join(workspace, ".git"))) return "";
  let tracked;
  try {
    tracked = new Set(execFileSync("git", ["ls-files", "--", ...task.allowedPaths], { cwd: workspace, encoding: "utf8", windowsHide: true })
      .split(/\r?\n/).filter(Boolean).map((p) => p.replaceAll("\\", "/")));
  } catch {
    return "";
  }
  const lines = task.allowedPaths.map((p) => {
    const normalized = p.replaceAll("\\", "/");
    if (tracked.has(normalized)) return `- ${p}: MODIFY (existing file; read only the region you change).`;
    if (existsSync(path.join(workspace, p))) return `- ${p}: CREATED BY THIS TASK in an earlier attempt (not in git). If it is broken, overwrite it completely with the full corrected content instead of patching it piece by piece.`;
    return `- ${p}: CREATE (does not exist yet; create it directly; do not search for it or verify its absence).`;
  });
  return ["File status (computed by Node from git):", ...lines].join("\n");
}

function correctionPromptText(task, qaOutput, attempt, codexCorrection = "", strategyRevision = false, { workspace } = {}) {
  return [
    `Correction for task ${task.id} (attempt ${attempt + 1}):`,
    "Next bounded correction:",
    codexCorrection.trim() || qaOutput.trim(),
    "Original task and acceptance criteria (preserve; do not redo completed work):",
    task.prompt,
    task.allowedPaths?.length
      ? `Change only these Codex-approved paths: ${task.allowedPaths.join(", ")}.`
      : "Change only files required by the original task.",
    describeAllowedPaths(task, workspace),
    "Cline: Do not commit or change git HEAD. Codex QA owns the accepted task commit under the approved workflow.",
    "The previous implementation did not pass Codex QA.",
    strategyRevision ? "This follows a five-attempt strategy reassessment. Use this revised approach; do not repeat the earlier implementation strategy." : "",
    "Fix only this task. Treat exact bytes, encoding, and line endings in QA output as requirements.",
    `Run this check before finishing: ${task.qaCommand}`,
    "Codex will rerun QA independently and will not trust your completion claim.",
    "Do not choose a new task.",
    clineHandoffSkill(task, codexCorrection),
  ].filter(Boolean).join("\n\n");
}

function initialPromptText(task, { workspace } = {}) {
  const allowed = task.allowedPaths?.length
    ? `Change only these Codex-approved paths: ${task.allowedPaths.join(", ")}.`
    : "Change only files required by this task.";
  return [
    task.prompt,
    allowed,
    describeAllowedPaths(task, workspace),
    "Cline: Do not commit or change git HEAD. Codex QA owns the accepted task commit under the approved workflow.",
    "Do not choose the next task; Codex owns planning and QA.",
    clineHandoffSkill(task),
  ].filter(Boolean).join("\n\n");
}

async function emit(onEvent, event) {
  if (onEvent) await onEvent(event);
}

async function stoppedBeforeLaunch(onEvent, shouldStop, attempt) {
  if (!shouldStop || !(await shouldStop())) return null;
  await emit(onEvent, { type: "stopped", attempt });
  return {
    status: "stopped",
    attempts: attempt,
    nextAction: "stop",
    qa: { pass: false, output: "Stop requested at a safe point before Cline launch." },
    history: [],
  };
}

async function runAttempts({
  task,
  worker,
  runQa,
  prepare,
  onEvent,
  shouldStop,
}) {
  const context = prepare ? await prepare() : undefined;
  let prompt = buildInitialPrompt(task);
  const history = [];
  await emit(onEvent, { type: "task-start", attempt: 0 });

  for (let attempt = 1; ; attempt += 1) {
    const stopped = await stoppedBeforeLaunch(onEvent, shouldStop, attempt - 1);
    if (stopped) {
      stopped.history = history;
      return stopped;
    }
    await emit(onEvent, { type: "cline-running", attempt });
    const workerResult = await worker.run(prompt);
    await emit(onEvent, { type: "cline-complete", attempt });
    await emit(onEvent, { type: "qa-running", attempt });
    const strategyRevision = attempt % 5 === 0;
    if (strategyRevision) await emit(onEvent, { type: "strategy-reassessment", attempt });
    const qa = await runQa({ task, attempt, workerResult, context, strategyRevision });
    history.push({ attempt, prompt, workerResult, qa });

    if (qa.pass) {
      await emit(onEvent, { type: "qa-pass", attempt, qa: qa.output });
      return {
        status: "passed",
        attempts: attempt,
        nextAction: "assess-next-task",
        workerResult,
        qa,
        history,
      };
    }

    await emit(onEvent, { type: "qa-fail", attempt, qa: qa.output });
    if (shouldStop && (await shouldStop())) {
      await emit(onEvent, { type: "stopped", attempt, qa: qa.output });
      return {
        status: "stopped",
        attempts: attempt,
        nextAction: "stop",
        qa,
        history,
      };
    }

    if (qa.status === "manual-review") {
      await emit(onEvent, { type: "manual-review", attempt, qa: qa.output });
      return { status: "manual-review", attempts: attempt, nextAction: "stop", qa, history };
    }
    prompt = buildCorrectionPrompt(task, qa.output, attempt, qa.correction, strategyRevision);
    await emit(onEvent, { type: "retry", attempt: attempt + 1, qa: qa.output });
  }
}

export async function runTask({
  task,
  worker,
  runQa,
  prepare,
  onEvent,
  shouldStop,
}) {
  const stopped = await stoppedBeforeLaunch(onEvent, shouldStop, 0);
  if (stopped) return stopped;

  if (worker.withExclusive) {
    const result = await worker.withExclusive(() =>
      runAttempts({ task, worker, runQa, prepare, onEvent, shouldStop }),
    );
    if (result) return result;
    await emit(onEvent, { type: "queued", attempt: 0 });
    return { status: "queued", attempts: 0, nextAction: "wait-for-cline" };
  }

  if (await worker.isBusy()) {
    await emit(onEvent, { type: "queued", attempt: 0 });
    return { status: "queued", attempts: 0, nextAction: "wait-for-cline" };
  }
  return runAttempts({ task, worker, runQa, prepare, onEvent, shouldStop });
}

// Every implementation prompt (Cline, OpenCode, Codex or Claude Code) leaves the machine without known secrets.
export const buildCorrectionPrompt = (...args) => redactText(correctionPromptText(...args), { assignments: false });
export const buildInitialPrompt = (...args) => redactText(initialPromptText(...args), { assignments: false });
