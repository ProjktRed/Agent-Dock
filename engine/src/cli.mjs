import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { ClineCliWorker } from "./cline-cli-worker.mjs";
import { CodexWorker, ROLE_EFFORT, ROLE_FAST, roleModel, useOrchestratorModels, useRoleOverrides } from "./codex-worker.mjs";
import { CLAUDE_MODELS, ClaudeWorker, preflightClaude } from "./claude-worker.mjs";
import { buildMixedOrchestrator, isMixed, roleClis, useMixedDefaults } from "./mixed-orchestrator.mjs";
import { preflightCodex, resolveCodexCommand } from "./codex-command.mjs";
import { DashboardState, atomicWriteJson } from "./dashboard-state.mjs";
import { readPendingCodex, runNodeLoop, validateTask } from "./node-loop.mjs";
import { installTopLevelDiagnostics } from "./diagnostics.mjs";
import { parseLoopOptions } from "./loop-options.mjs";
import { prepareClineRuntime } from "./cline-runtime-config.mjs";
import { TUNING, useTuning } from "./engine-tuning.mjs";
import { createCloudImplementation, createRoles } from "./engine-setup.mjs";

installTopLevelDiagnostics();

const exec = promisify(execFile);
const options = parseLoopOptions(process.argv.slice(2));
if (!options.workspace || !options.objective) {
  console.error('Usage: npm start -- --workspace <repo> --objective "<bounded project objective>" [--task task.json]');
  process.exit(64);
}
const workspace = path.resolve(options.workspace);
const stateDir = path.resolve(options["state-dir"] ?? ".state");
const maxAttempts = null;
const pollMs = Number(options["poll-seconds"] ?? 2) * 1000;
if (!Number.isFinite(pollMs) || pollMs < 100) throw new Error("Invalid polling interval");
const initialTask = options.task ? JSON.parse(await readFile(path.resolve(options.task), "utf8")) : null;
if (initialTask) validateTask(initialTask);
useTuning(options.tuning);
console.log(JSON.stringify({ tuning: TUNING }));
// Implementation: Cline (local provider) by default, or Codex / Claude Code (--implementation-cli).
const cloudImplementation = await createCloudImplementation(options, { stateDir, workspace });
let clineRuntime = null;
let provider;
let model;
if (cloudImplementation) {
  provider = cloudImplementation.provider;
  model = cloudImplementation.model;
  console.log(JSON.stringify({ implementation: options.implementation }));
} else {
  clineRuntime = await prepareClineRuntime({
    stateDir,
    provider: options.provider,
    model: options.model,
    contextTokens: options.clineContextTokens,
    maxOutputTokens: options.clineMaxOutputTokens,
    timeoutSeconds: options.timeoutSeconds,
    llamaCppModelsDir: options.llamacppModelsDir,
    ...(options.llamacppLauncher ? { llamaCppLauncher: options.llamacppLauncher } : {}),
    thinking: options.clineThinking,
  });
  provider = clineRuntime.provider;
  model = clineRuntime.model;
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
const worker = cloudImplementation?.worker ?? new ClineCliWorker({
  toolGuard: options.toolGuard,
  thinking: options.clineThinking,
  stateDir, workspace, clineJs: options["cline-js"],
  provider, model,
  timeoutSeconds: options.timeoutSeconds,
  contextTokens: options.clineContextTokens,
  dataDir: clineRuntime.dataDir,
  requestedProvider: clineRuntime.requestedProvider,
  baseUrl: clineRuntime.baseUrl,
  beforeRun: clineRuntime.ensureReady,
  readMetrics: clineRuntime.readMetrics,
});
const gitCommonOutput = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
  cwd: workspace,
  windowsHide: true,
});
const gitCommonDir = path.resolve(workspace, gitCommonOutput.stdout.trim());
const gitCommonIsOutsideWorkspace = path.relative(workspace, gitCommonDir).split(path.sep)[0] === "..";
const codex = mixed
  ? await buildMixedOrchestrator({ options, clis, stateDir, workspace, additionalWritableDirs: gitCommonIsOutsideWorkspace ? [gitCommonDir] : [] })
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
try {
  const result = await runNodeLoop({
    workspace, stateDir, objective: options.objective, initialTask, codex, worker, maxAttempts, pollMs,
    solReassessmentEnabled: options.solReassessment,
    manualResolver: options['resolve-block']==='true',
    onTask: (task) => state.initialize({ task, workspace, maxAttempts, contextTokens: options.clineContextTokens, timeoutSeconds: options.timeoutSeconds, model, provider }),
    onEvent: (event) => state.record(event),
    readControl: () => state.readControl(), pendingCodex,
    roles, runRole,
  });
  await atomicWriteJson(path.join(stateDir, "loop-result.json"), result);
  console.log(JSON.stringify(result));
  process.exitCode = result.status === "blocked" ? 1 : 0;
} catch (error) {
  await state.record({ type: "blocked", qa: error.stack ?? error.message });
  await atomicWriteJson(path.join(stateDir, "loop-result.json"), { status: "blocked", output: error.message });
  console.error(error.message);
  process.exitCode = 1;
}
