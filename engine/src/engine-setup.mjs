import { CloudImplementationWorker } from "./cloud-impl-worker.mjs";
import { trackRunEvent } from "./run-budget.mjs";
import { superviseEvent } from "./supervisor.mjs";
import { notifyEvent } from "./notify.mjs";
import { diagnostic } from "./diagnostics.mjs";
import { CodexWorker } from "./codex-worker.mjs";
import { ClaudeWorker, preflightClaude } from "./claude-worker.mjs";
import { preflightCodex, resolveCodexCommand } from "./codex-command.mjs";
import { createRoleRunner, readRolesFile } from "./workflow-roles.mjs";
import { ClineCliWorker } from "./cline-cli-worker.mjs";
import { prepareClineRuntime } from "./cline-runtime-config.mjs";
import { brokerProviderKey, createProviderDescriptor } from "./runtime/provider.mjs";
import { OpenCodeCliWorker } from "./opencode-cli-worker.mjs";

// The engine owns this task boundary. An app polling QA PASS can arrive after
// the next Assessment has already started.
export async function recordLoopEvent(state,event,{autoContinue=true}={}) {
  if(event.type==='qa-pass'&&!autoContinue)await state.setControl('pause');
  await state.record(event);
  await trackRunEvent(state,event);
  notifyEvent(event);
  // The Supervisor watches; a monitor that fails must never stop the loop.
  await superviseEvent(event).catch((error)=>diagnostic("SUPERVISOR_FAILED",{message:error.message}));
}

/** Codex or Claude Code as the implementation worker (--implementation-cli). Null for Cline. */
export async function createCloudImplementation(options, { stateDir, workspace }) {
  const impl = options.implementation;
  if (!impl || impl.cli === "cline") return null;
  let command, prefixArgs = [];
  if (impl.cli === "codex") {
    const launcher = await resolveCodexCommand({ explicitCommand: options["codex-command"] ?? options["codex-exe"] });
    await preflightCodex(launcher);
    command = launcher.command;
    prefixArgs = launcher.prefixArgs ?? [];
  } else {
    command = options["claude-command"] ?? "claude";
    await preflightClaude(command);
  }
  const worker = new CloudImplementationWorker({
    cli: impl.cli, stateDir, workspace, command, prefixArgs,
    model: impl.model, effort: impl.effort, fast: impl.fast,
    timeoutSeconds: options.timeoutSeconds, toolGuard: options.toolGuard,
  });
  return { worker, provider: impl.cli, model: impl.model ?? `${impl.cli} default` };
}

/** Build the implementation worker selected by the Implementation agent's CLI kind. */
export async function createImplementationWorker(options, { stateDir, workspace, state, lazy = false }) {
  const implCli = options.implementation?.cli ?? "cline";
  if (implCli === "codex" || implCli === "claude") {
    const cloud = await createCloudImplementation(options, { stateDir, workspace });
    return { ...cloud, runtime: null };
  }

  const initialize = async () => {
    if (!options.model) throw new Error(`Choose the Implementation agent's model (--model): ${options.provider} has no default model.`);
    if (implCli === "opencode") {
      let providerDescriptor;
      let runtime = null;
      if (options.provider === "llamacpp" || options.provider === "ollama") {
        runtime = await prepareClineRuntime({
          stateDir, provider: options.provider, model: options.model, externalServer: options["local-server-managed"] === "external",
          contextTokens: options.clineContextTokens, maxOutputTokens: options.clineMaxOutputTokens,
          timeoutSeconds: options.timeoutSeconds, llamaCppModelsDir: options.llamacppModelsDir,
          ...(options.llamacppLauncher ? { llamaCppLauncher: options.llamacppLauncher } : {}),
          ...(options.llamacppUrl ? { llamaCppUrl: options.llamacppUrl } : {}),
          ...(options.ollamaUrl ? { ollamaUrl: options.ollamaUrl } : {}),
          thinking: options.clineThinking,
        });
        providerDescriptor = {
          id: options.provider,
          baseUrl: options.provider === "ollama" ? `${runtime.baseUrl.replace(/\/$/, "")}/v1` : runtime.baseUrl,
          model: runtime.model,
          apiKeyEnv: null, contextTokens: options.clineContextTokens,
          maxOutputTokens: options.clineMaxOutputTokens, timeoutMs: options.timeoutSeconds * 1000,
          preflight: runtime.ensureReady ?? (async () => ({ requestedProvider: options.provider, provider: options.provider, baseUrl: runtime.baseUrl, model: runtime.model })),
          readMetrics: runtime.readMetrics,
        };
      } else {
        // OpenCode gets the key broker's address and token, never the key (key-broker.mjs).
        const broker = await brokerProviderKey({ provider: options.provider, providerBaseUrl: options.providerBaseUrl, providerApiKeyEnv: options.providerApiKeyEnv });
        providerDescriptor = createProviderDescriptor({
          broker,
          provider: options.provider,
          model: options.model,
          contextTokens: options.clineContextTokens,
          maxOutputTokens: options.clineMaxOutputTokens,
          timeoutSeconds: options.timeoutSeconds,
          providerBaseUrl: options.providerBaseUrl,
          providerApiKeyEnv: options.providerApiKeyEnv,
        });
      }
      const worker = new OpenCodeCliWorker({
        stateDir, workspace, providerDescriptor, toolGuard: options.toolGuard,
        timeoutSeconds: options.timeoutSeconds, command: options["opencode-exe"] ?? options["opencode-command"],
      });
      return { worker, provider: providerDescriptor.id, model: providerDescriptor.model, runtime: runtime ?? providerDescriptor };
    }

    const runtime = await prepareClineRuntime({
      stateDir, provider: options.provider, model: options.model, externalServer: options["local-server-managed"] === "external",
      contextTokens: options.clineContextTokens, maxOutputTokens: options.clineMaxOutputTokens,
      timeoutSeconds: options.timeoutSeconds, llamaCppModelsDir: options.llamacppModelsDir,
      ...(options.llamacppLauncher ? { llamaCppLauncher: options.llamacppLauncher } : {}),
      ...(options.llamacppUrl ? { llamaCppUrl: options.llamacppUrl } : {}),
      ...(options.ollamaUrl ? { ollamaUrl: options.ollamaUrl } : {}),
      providerBaseUrl: options.providerBaseUrl, providerApiKeyEnv: options.providerApiKeyEnv,
      thinking: options.clineThinking,
    });
    const worker = new ClineCliWorker({
      toolGuard: options.toolGuard, thinking: options.clineThinking, stateDir, workspace,
      clineJs: options["cline-js"], provider: runtime.provider, model: runtime.model,
      timeoutSeconds: options.timeoutSeconds, contextTokens: options.clineContextTokens,
      dataDir: runtime.dataDir, requestedProvider: runtime.requestedProvider,
      baseUrl: runtime.baseUrl, beforeRun: runtime.ensureReady,
      cleanupAfterRun: runtime.cleanupAfterRun, providerEnv: runtime.providerEnv,
      readMetrics: runtime.readMetrics,
      // A parallel task: the other tasks' Cline processes are not someone else using Cline (each has its own state).
      ...(options["parallel-child"] === "true" ? { checkExternalBusy: async () => false } : {}),
    });
    return { worker, provider: runtime.provider, model: runtime.model, runtime };
  };

  if (!lazy) {
    const result = await initialize();
    if (state && result.runtime) await state.configureRuntime({
      contextTokens: options.clineContextTokens, timeoutSeconds: options.timeoutSeconds,
      model: result.model, provider: result.provider,
    });
    return result;
  }

  let initialized;
  const getWorker = async () => {
    if (!initialized) initialized = initialize().then(async (result) => {
      if (state && result.runtime) await state.configureRuntime({
        contextTokens: options.clineContextTokens, timeoutSeconds: options.timeoutSeconds,
        model: result.model, provider: result.provider,
      });
      return result.worker;
    });
    return initialized;
  };
  const worker = {
    withExclusive: async (operation) => (await getWorker()).withExclusive(operation),
    run: async (...args) => (await getWorker()).run(...args),
  };
  return { worker, provider: options.provider, model: options.model, runtime: null };
}

/** Custom workflow roles (--roles-file) and the runner for them; each CLI a role needs is preflighted once. */
export async function createRoles(options, { stateDir, workspace }) {
  const roles = await readRolesFile(options.rolesFile);
  if (!roles.length) return { roles, runRole: null, fixWorkers: {} };
  const needed = new Set(roles.map((role) => role.cli));
  const workers = {};
  if (needed.has("codex")) {
    const launcher = await resolveCodexCommand({ explicitCommand: options["codex-command"] ?? options["codex-exe"] });
    await preflightCodex(launcher);
    workers.codex = new CodexWorker({ stateDir, workspace, launcher, windowsSandbox: options["codex-windows-sandbox"] });
  }
  if (needed.has("claude")) {
    const claudeCommand = options["claude-command"] ?? "claude";
    await preflightClaude(claudeCommand);
    workers.claude = new ClaudeWorker({ stateDir, workspace, claudeCommand });
  }
  // Fixers edit through a guarded implementation run on their own CLI; the tool guard is always on.
  const fixWorkers = {};
  for (const role of roles.filter((r) => r.fix)) {
    const command = role.cli === "codex" ? workers.codex.command : options["claude-command"] ?? "claude";
    const prefixArgs = role.cli === "codex" ? workers.codex.prefixArgs : [];
    fixWorkers[role.id] = new CloudImplementationWorker({ cli: role.cli, stateDir, workspace, command, prefixArgs, model: role.model, effort: role.effort, fast: role.fast, timeoutSeconds: options.timeoutSeconds, toolGuard: true });
  }
  return { roles, runRole: createRoleRunner(workers), fixWorkers };
}

/** A failed startup git query, rethrown with git's own reason (e.g. "detected dubious ownership"). */
export function gitStartupError(error) {
  const reason = String(error?.stderr || error?.message || error).split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? 'unknown error';
  throw new Error(`git cannot read the workspace repository: ${reason}`);
}
