import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { CodexWorker, ROLE_EFFORT, ROLE_FAST, roleModel, useOrchestratorModels, useRoleOverrides } from "./codex-worker.mjs";
import { CLAUDE_MODELS, ClaudeWorker, preflightClaude } from "./claude-worker.mjs";
import { buildMixedOrchestrator, isMixed, roleClis, useMixedDefaults } from "./mixed-orchestrator.mjs";
import { preflightCodex, resolveCodexCommand } from "./codex-command.mjs";
import { DashboardState, atomicWriteJson, flushActionLog } from "./dashboard-state.mjs";
import { readPendingCodex, runNodeLoop, validateTask } from "./node-loop.mjs";
import { installTopLevelDiagnostics } from "./diagnostics.mjs";
import { parseLoopOptions } from "./loop-options.mjs";
import { TUNING, useTuning } from "./engine-tuning.mjs";
import { createImplementationWorker, createRoles, gitStartupError, recordLoopEvent } from "./engine-setup.mjs";
import {configureProtection} from './guard/protected-paths.mjs';
import { parseRunLimits, startDeadline, useRunLimits, watchUsage, writeRunReport } from "./run-budget.mjs";
import { applyApprovedPlanProposals, queuePlanTick } from "./plan-stewardship.mjs";
import { applyRetention } from "./retention.mjs";
import { awaitSupervisorReview, digest, parseSupervisorOptions, startSupervisor, superviseTask, supervisorAlerts } from "./supervisor.mjs";
import { createReviewer } from "./supervisor-review.mjs";
import { flushNotifications, notifyEvent, notifyFromEnv } from "./notify.mjs";

installTopLevelDiagnostics();

const exec = promisify(execFile);
const options = parseLoopOptions(process.argv.slice(2));
if (!options.workspace || !options.objective) {
  console.error('Usage: npm start -- --workspace <repo> --objective "<bounded project objective>" [--task task.json]');
  process.exit(64);
}
const workspace = path.resolve(options.workspace);
const stateDir = path.resolve(options["state-dir"] ?? ".state");
configureProtection({workspace,stateDir,paths:options['protected-paths']});
const maxAttempts = null;
const pollMs = Number(options["poll-seconds"] ?? 2) * 1000;
if (!Number.isFinite(pollMs) || pollMs < 100) throw new Error("Invalid polling interval");
const initialTask = options.task ? JSON.parse(await readFile(path.resolve(options.task), "utf8")) : null;
if (initialTask) validateTask(initialTask);
useTuning(options.tuning);
console.log(JSON.stringify({ tuning: TUNING }));
const implementation = await createImplementationWorker(options, { stateDir, workspace });
const provider = implementation.provider;
const model = implementation.model;
if (options.implementation.cli !== "cline") {
  console.log(JSON.stringify({ implementation: options.implementation }));
} else if (implementation.runtime?.requestedProvider === "llamacpp" || implementation.runtime?.requestedProvider === "ollama") {
  const clineRuntime = implementation.runtime;
  console.log(JSON.stringify({
    localModelRuntime: {
      requestedProvider: clineRuntime.requestedProvider,
      effectiveProvider: provider,
      endpoint: clineRuntime.baseUrl ?? null,
      port: clineRuntime.port ?? null,
      model,
      contextTokens: options.clineContextTokens,
      maxOutputTokens: options.clineMaxOutputTokens,
      startedServer: clineRuntime.startedServer ?? false,
      fallback: false,
    },
  }));
} else if (implementation.runtime) {
  console.log(JSON.stringify({ implementationProvider: implementation.runtime.requestedProvider ?? implementation.runtime.id, model }));
}
const useClaude = options.orchestrator === "claude";
if (options.orchestrator && !["codex", "claude"].includes(options.orchestrator)) throw new Error("--orchestrator must be codex or claude");
let codexLauncher = null;
if (useClaude) {
  useOrchestratorModels(CLAUDE_MODELS);
  const claudePreflight = await preflightClaude(options["claude-command"] ?? "claude");
  console.log(JSON.stringify({ orchestrator: "claude", claudeCommand: claudePreflight.command, auth: claudePreflight.auth, models: CLAUDE_MODELS }));
} else {
  codexLauncher = await resolveCodexCommand({
    explicitCommand: options["codex-command"] ?? options["codex-exe"],
  });
  const codexPreflight = await preflightCodex(codexLauncher);
  console.log(JSON.stringify({ codexCommand: codexPreflight.command, codexVersion: codexPreflight.version }));
}
const clis = roleClis(options);
const mixed = isMixed(clis);
if (mixed) useMixedDefaults(clis);
useRoleOverrides(options.roleOverrides);
console.log(JSON.stringify({ orchestratorRoles: Object.fromEntries(Object.keys(ROLE_EFFORT).map((role) => [role, { cli: clis[role], model: roleModel(role), effort: ROLE_EFFORT[role], fast: ROLE_FAST[role] }])) }));
const { roles, runRole } = await createRoles(options, { stateDir, workspace });
if (roles.length) console.log(JSON.stringify({ workflowRoles: roles.map(({ instructions: _text, ...role }) => role) }));
const state = new DashboardState({ stateDir });
const worker = implementation.worker;
const gitCommonOutput = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
  cwd: workspace,
  windowsHide: true,
}).catch(gitStartupError);
const gitCommonDir = path.resolve(workspace, gitCommonOutput.stdout.trim());
const gitCommonIsOutsideWorkspace = path.relative(workspace, gitCommonDir).split(path.sep)[0] === "..";
const codex = mixed || Object.keys(options.roleBackups).length
  ? await buildMixedOrchestrator({ options, clis, stateDir, workspace, additionalWritableDirs: gitCommonIsOutsideWorkspace ? [gitCommonDir] : [], onEvent: event => state.record(event) })
  : useClaude
  ? new ClaudeWorker({
      stateDir,
      workspace,
      claudeCommand: options["claude-command"] ?? "claude",
      additionalWritableDirs: gitCommonIsOutsideWorkspace ? [gitCommonDir] : [],
    })
  : new CodexWorker({
      stateDir,
      workspace,
      launcher: codexLauncher,
      windowsSandbox: options["codex-windows-sandbox"],
      additionalWritableDirs: gitCommonIsOutsideWorkspace ? [gitCommonDir] : [],
    });
const pendingCodex = await readPendingCodex(stateDir);
if (!(await state.readLive())) {
  await state.initialize({
    task: pendingCodex?.context?.task ?? pendingCodex?.inputs?.task ?? initialTask ?? { id: "assessment", name: "Assessing project", prompt: options.objective },
    workspace,
    maxAttempts,
    contextTokens: options.clineContextTokens,
    timeoutSeconds: options.timeoutSeconds,
    model,
    provider,
  });
}
await state.configureRuntime({ contextTokens: options.clineContextTokens, timeoutSeconds: options.timeoutSeconds, model, provider });
useRunLimits(parseRunLimits(options));
notifyFromEnv();
const supervisorConfig = parseSupervisorOptions(options);
await watchUsage(state, stateDir);
const deadline = startDeadline(state);
// A reviewer that cannot be set up turns the review off for this run instead of failing the run.
const reviewer = supervisorConfig.mode !== "off" && supervisorConfig.review !== "off"
  ? await createReviewer({ kind: options["supervisor-reviewer"] ?? (useClaude ? "claude" : "codex"), model: options["supervisor-model"], baseUrl: options["supervisor-base-url"], stateDir, workspace, codexLauncher, options })
    .catch(async (error) => { await state.record({ type: "supervisor-review-failed", message: `Supervisor review is off for this run: ${error.message}` }); return null; })
  : null;
// Retention: old per-call folders, Cline sessions and log archives go before the run adds new ones.
const retentionDays = options["retention-days"] === undefined ? 30 : Number(options["retention-days"]);
if (!Number.isFinite(retentionDays) || retentionDays < 0) throw new Error("--retention-days must be a number of days, 0 to keep everything");
const retention = await applyRetention(stateDir, { days: retentionDays }).catch(() => null);
if (retention && (retention.calls || retention.sessions || retention.setAside || retention.activityTrimmed || retention.actionLogRotated || retention.actionLogPruned))
  await state.record({ type: "retention", days: retentionDays, ...retention });
const stopSupervisor = startSupervisor(state, { workspace, stateDir, config: supervisorConfig, reviewer });
try {
  const result = await runNodeLoop({
    workspace, stateDir, objective: options.objective, initialTask, codex, worker, maxAttempts, pollMs,
    solReassessmentEnabled: options.solReassessment,
    manualResolver: options['resolve-block']==='true',
    betweenTasks: () => applyApprovedPlanProposals({ stateDir, workspace, state }).catch(() => {}),
    onTask: async (task) => { await state.initialize({ task, workspace, maxAttempts, contextTokens: options.clineContextTokens, timeoutSeconds: options.timeoutSeconds, model, provider }); await superviseTask(task).catch(() => {}); },
    onEvent: async (event) => {
      await recordLoopEvent(state,event,options);
      if (event.type === "qa-pass" && Array.isArray(event.planItems)) for (const item of event.planItems) await queuePlanTick({ stateDir, taskId: state.live?.task?.id, item }).catch(() => {});
    },
    readControl: () => state.readControl(), pendingCodex,
    roles, runRole,
  });
  await atomicWriteJson(path.join(stateDir, "loop-result.json"), result);
  await writeRunReport(stateDir, { ...result, supervisorAlerts: supervisorAlerts().length });
  if (supervisorConfig.mode !== "off") await digest("final").catch(() => {});
  console.log(JSON.stringify(result));
  process.exitCode = result.status === "blocked" ? 1 : 0;
} catch (error) {
  await state.record({ type: "blocked", qa: error.stack ?? error.message });
  notifyEvent({ type: "blocked", qa: error.message });
  await atomicWriteJson(path.join(stateDir, "loop-result.json"), { status: "blocked", output: error.message });
  await writeRunReport(stateDir, { status: "blocked", output: error.message, supervisorAlerts: supervisorAlerts().length }).catch(() => {});
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (deadline) clearTimeout(deadline);
  // A run that ends right after an approval (a task limit, Stop) applies its plan check-offs and approved plan changes now (clean tree only).
  // Never while a task is in progress: an extra commit would move HEAD under its recovery.
  const current = await readFile(path.join(stateDir, "current-task.json"), "utf8").then(JSON.parse, () => null);
  if (!current || current.automation?.recovery?.phase === "passed") await applyApprovedPlanProposals({ stateDir, workspace, state }).catch(() => {});
  stopSupervisor();
  await awaitSupervisorReview();
  await flushNotifications();
  await flushActionLog();
}
