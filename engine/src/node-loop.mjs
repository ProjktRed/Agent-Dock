import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { atomicWriteJson, DashboardState } from "./dashboard-state.mjs";
import { CodexUsageLimitError, detectCodexUsageLimit, ROLE_EFFORT, roleModel } from "./codex-worker.mjs";
import { captureGitBaseline } from "./qa-runner.mjs";
import { classifyQaCommand, prepareQaPacket, collectGitEvidence } from "./qa-packet.mjs";
import { buildCorrectionPrompt, buildInitialPrompt } from "./workflow.mjs";
import { diagnostic } from "./diagnostics.mjs";

const exec = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Read-only git calls: no fsmonitor program from the repository's config runs (same results without it).
const git = async (workspace, ...args) => (await exec("git", ["-c", "core.fsmonitor=false", ...args], { cwd: workspace, windowsHide: true })).stdout.trim();
const pendingPath = (stateDir) => path.join(stateDir, "pending-codex.json");

export async function readPendingCodex(stateDir) {
  let pending = null;
  try { pending = JSON.parse(await readFile(pendingPath(stateDir), "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  let live = null;
  try { live = JSON.parse(await readFile(path.join(stateDir, "live.json"), "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const completed = live?.codexOperation?.status === "completed" ? live.codexOperation : null;
  if (completed && (!pending || !pending.operationId || pending.operationId === completed.operationId)) return completed;
  return pending;
}

export async function runRecoverableCodex({
  stateDir, operation, inputs, context = {}, invoke, emit, readControl, pollMs, pending = null,
  writePending = atomicWriteJson,
  beforeInvoke = async () => true,
  removePending = (file) => rm(file, { force: true }),
}) {
  let record = pending ?? {
    version: 2,
    operationId: randomUUID(),
    operation,
    taskId: inputs.task?.id ?? null,
    attempt: inputs.attempt ?? null,
    inputs,
    context,
    limit: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  record = {
    ...record,
    version: 2,
    operationId: record.operationId ?? randomUUID(),
    status: record.status ?? "pending",
  };
  const customRole = operation.startsWith("role:");
  const startType = customRole ? "role-started" : operation === "resolver" ? "resolver-started" : operation === "qa" ? "codex-qa-started" : operation === "elevate" ? "sol-reassessment-started" : "codex-assessing";
  const finishType = customRole ? "role-finished" : operation === "resolver" ? "resolver-finished" : operation === "qa" ? "codex-qa-finished" : operation === "elevate" ? "sol-reassessment-finished" : "codex-finished";
  let waitBeforeInvoke = Boolean(pending?.limit);
  let waitingResumeGeneration = pending?.waitingResumeGeneration;

  for (;;) {
    if (record.status === "completed") {
      await emit(finishType, { operationId: record.operationId, codexOperation: record });
      await removePending(pendingPath(stateDir));
      return { result: record.result, operationId: record.operationId };
    }
    if (!waitBeforeInvoke) {
      record = { ...record, status: "running", inputs, context, limit: null, waitingResumeGeneration: null, updatedAt: new Date().toISOString() };
      await writePending(pendingPath(stateDir), record);
      if(!await beforeInvoke())return {stopped:true};
      const operationStarted = Date.now();
      const role = ['qa', 'elevate', 'resolver'].includes(operation) ? operation : 'assessment';
      const qaTelemetry = operation === "qa" ? {
        attempt: inputs.attempt,
        changedFileCount: inputs.changedFiles?.length ?? 0,
        diffByteCount: inputs.diff?.bytes ?? 0,
        commands: inputs.qaEvidence?.command?.command ? [inputs.qaEvidence.command.command] : [],
      } : operation === "elevate" ? { startedAt: new Date(operationStarted).toISOString(), model: roleModel("elevate"), reasoningEffort: ROLE_EFFORT.elevate } : {};
      if (customRole) await emit(startType, { operation, roleName: context.roleName, stage: context.roleStage, model: context.roleModel ?? null, startedAt: new Date(operationStarted).toISOString(), operationId: record.operationId });
      else await emit(startType, { ...qaTelemetry, operation, startedAt:new Date(operationStarted).toISOString(), model: roleModel(role), reasoningEffort: ROLE_EFFORT[role], automatic: context.automatic, triggeredBy: context.triggeredBy, operationId: record.operationId });
      let result;
      try {
        if(!await beforeInvoke())return {stopped:true};
        result = await invoke(inputs);
      } catch (error) {
        if (!(error instanceof CodexUsageLimitError) && error?.code !== "CODEX_USAGE_LIMIT") {
          await removePending(pendingPath(stateDir));
          throw error;
        }
        waitingResumeGeneration = Number((await readControl()).resumeGeneration ?? 0);
        record = {
          ...record,
          limit: { message: error.message, retryAt: error.retryAt ?? null },
          waitingResumeGeneration,
          updatedAt: new Date().toISOString(),
        };
        await writePending(pendingPath(stateDir), record);
        await emit("codex-usage-limit", { operation, attempt: inputs.attempt, message: error.message, retryAt: error.retryAt ?? null });
        await emit("waiting-for-codex", { operation, attempt: inputs.attempt, message: error.message, retryAt: error.retryAt ?? null });
        if (error.retryAt) await emit("resume-available-after", { operation, attempt: inputs.attempt, retryAt: error.retryAt });
        waitBeforeInvoke = true;
      }
      if (!waitBeforeInvoke) {
        record = { ...record, status: "completed", result, completedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        await writePending(pendingPath(stateDir), record);
        await emit(finishType, {
          ...(operation === "qa" ? { ...qaTelemetry, durationMs: Date.now() - operationStarted } : {}),
          operationId: record.operationId,
          codexOperation: record,
        });
        await removePending(pendingPath(stateDir));
        return { result, operationId: record.operationId };
      }
    } else {
      waitingResumeGeneration ??= Number((await readControl()).resumeGeneration ?? 0);
      await emit("waiting-for-codex", {
        operation,
        attempt: inputs.attempt,
        message: record.limit?.message,
        retryAt: record.limit?.retryAt ?? null,
      });
    }

    for (;;) {
      const control = await readControl();
      if (control.stopAfterSafePoint) {
        await emit("stopped");
        return { stopped: true };
      }
      if (Number(control.resumeGeneration ?? 0) > waitingResumeGeneration) {
        waitBeforeInvoke = false;
        break;
      }
      await sleep(pollMs);
    }
  }
}

export async function recoverLegacyQaLimit({ stateDir }) {
  const state = new DashboardState({ stateDir });
  const waitingResumeGeneration = Number((await state.readControl()).resumeGeneration ?? 0);
  const codexDir = path.join(stateDir, "codex");
  const candidates = [];
  for (const name of await readdir(codexDir)) {
    const directory = path.join(codexDir, name);
    const details = await stat(directory);
    if (details.isDirectory()) candidates.push({ directory, modified: details.mtimeMs });
  }
  candidates.sort((a, b) => b.modified - a.modified);
  for (const { directory } of candidates) {
    const events = await readFile(path.join(directory, "events.ndjson"), "utf8").catch(() => "");
    const limit = detectCodexUsageLimit(events);
    if (!limit) continue;
    const prompt = await readFile(path.join(directory, "prompt.txt"), "utf8");
    const marker = "\nINPUT: ";
    const offset = prompt.lastIndexOf(marker);
    if (offset < 0) throw new Error("Usage-limited Codex QA prompt has no recoverable INPUT payload");
    const inputs = JSON.parse(prompt.slice(offset + marker.length));
    if (!inputs.task || !Number.isInteger(inputs.attempt) || !inputs.baselineHead || !inputs.workerResult) {
      throw new Error("Usage-limited Codex QA INPUT payload is incomplete");
    }
    const record = {
      version: 1, operation: "qa", taskId: inputs.task.id, attempt: inputs.attempt, inputs,
      context: { prompt: buildInitialPrompt(inputs.task), history: [] },
      limit, waitingResumeGeneration, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    await atomicWriteJson(pendingPath(stateDir), record);
    await state.record({ type: "codex-usage-limit", operation: "qa", attempt: inputs.attempt, message: limit.message, retryAt: limit.retryAt });
    await state.record({ type: "waiting-for-codex", operation: "qa", attempt: inputs.attempt, message: limit.message, retryAt: limit.retryAt });
    if (limit.retryAt) await state.record({ type: "resume-available-after", operation: "qa", attempt: inputs.attempt, retryAt: limit.retryAt });
    return record;
  }
  throw new Error("No structured Codex usage-limit QA failure was found");
}

export function validateTask(task) {
  if (!task || !["id", "prompt", "qaCommand"].every((key) => typeof task[key] === "string" && task[key].trim()) ||
      !Array.isArray(task.allowedPaths) || !task.allowedPaths.length ||
      task.allowedPaths.some((p) => typeof p !== "string" || !p || path.isAbsolute(p) || p.split(/[\\/]/).includes("..") || /[*?]/.test(p))) {
    throw new Error("Codex returned an invalid or unbounded task");
  }
}

export async function verifyReview({ workspace, baselineHead, decision, task }) {
  const head = await git(workspace, "rev-parse", "HEAD");
  if (decision.status !== "pass") {
    if (head !== baselineHead) throw new Error("Non-PASS QA changed HEAD; manual review required");
    return;
  }
  if (!decision.output?.trim() || !decision.commit || head !== decision.commit || head === baselineHead) {
    throw new Error("PASS missing QA evidence or a matching new commit");
  }
  const parents = await git(workspace, "rev-list", "--parents", "-n", "1", "HEAD");
  if (parents !== head + " " + baselineHead) throw new Error("PASS must contain exactly one task commit");
  const files = (await git(workspace, "diff", "--no-renames", "--name-only", "-z", baselineHead, head)).split("\0").filter(Boolean);
  if (!files.length || files.some((file) => !task.allowedPaths.map((p) => p.replaceAll("\\", "/")).includes(file))) {
    throw new Error("Accepted commit has changes outside the bounded task");
  }
  await captureGitBaseline(workspace);
}

export { runNodeLoop } from "./recovery-loop.mjs";
