import { CodexWorker, useRoleOverrides } from "./codex-worker.mjs";
import { CLAUDE_MODELS, ClaudeWorker, preflightClaude } from "./claude-worker.mjs";
import { preflightCodex, resolveCodexCommand } from "./codex-command.mjs";
import { ORCHESTRATOR_ROLES } from "./loop-options.mjs";
import { assertQaPacketFresh, collectGitEvidence } from "./qa-packet.mjs";

const CODEX_DEFAULTS = { qa: "gpt-6.1-sol", assessment: "gpt-6.1-sol", resolver: "gpt-6.1-sol", elevate: "gpt-6-astra" };

/** Orchestrator CLI per role (--<role>-cli), falling back to --orchestrator. Resolver follows Assessment. */
export function roleClis(options) {
  const main = options.orchestrator ?? "codex";
  const clis = {};
  for (const role of ORCHESTRATOR_ROLES) {
    const value = options[`${role}-cli`] ?? (role === "resolver" ? options["assessment-cli"] : undefined) ?? main;
    if (!["codex", "claude"].includes(value)) throw new Error(`--${role}-cli must be codex or claude`);
    clis[role] = value;
  }
  return clis;
}

export const isMixed = (clis) => new Set(Object.values(clis)).size > 1;

/** Each role's default model comes from its own CLI when roles run on different CLIs. */
export function useMixedDefaults(clis) {
  useRoleOverrides(Object.fromEntries(ORCHESTRATOR_ROLES.map((role) => [role, { model: clis[role] === "claude" ? CLAUDE_MODELS[role] : CODEX_DEFAULTS[role] }])));
}

/**
 * Routes each orchestrator role to its own worker (Codex or Claude Code). Both workers share the
 * single orchestrator lock (codex-process.json in the state folder), so calls stay sequential.
 */
export class RoleRoutedOrchestrator {
  constructor(workers, { backups = {}, onEvent = async () => {}, clis = {}, backupConfigs = {}, beforeFallback = async () => {} } = {}) {
    this.workers = workers;
    this.backups = backups;
    this.onEvent = onEvent;
    this.clis = clis;
    this.backupConfigs = backupConfigs;
    this.beforeFallback = beforeFallback;
  }

  get distinct() {
    return [...new Set([...Object.values(this.workers), ...Object.values(this.backups)])];
  }

  get activeCount() {
    return this.distinct.reduce((sum, worker) => sum + (worker.activeCount ?? 0), 0);
  }

  async assertIdle() {
    for (const worker of this.distinct) await worker.assertIdle();
  }

  async run(role, method, args) {
    try { return await this.workers[role][method](...args); }
    catch (error) {
      const backup = this.backups[role];
      if (error?.code !== "CODEX_USAGE_LIMIT" || !backup) throw error;
      // A failed child must be fully closed before another CLI takes the shared lock.
      await this.assertIdle();
      await this.beforeFallback(role, args);
      const config = this.backupConfigs[role];
      await this.onEvent({ type: "orchestrator-fallback", role, operation: method, fromCli: this.clis[role], toCli: config?.cli, model: config?.model ?? null, reasoningEffort: config?.effort ?? "medium", fast: Boolean(config?.fast), attempt: args[0]?.attempt, message: error.message });
      return backup[method](...args);
    }
  }

  assess(...args) { return this.run("assessment", "assess", args); }
  review(...args) { return this.run("qa", "review", args); }
  assessCorrection(...args) { return this.run("assessment", "assessCorrection", args); }
  reassessManualReview(...args) { return this.run("elevate", "reassessManualReview", args); }
  resolveBlocked(...args) { return this.run("resolver", "resolveBlocked", args); }
}

/** Preflight every CLI a role needs and build the routed orchestrator. */
export async function buildMixedOrchestrator({ options, clis, stateDir, workspace, additionalWritableDirs = [], onEvent }) {
  const backupConfigs = Object.fromEntries(Object.entries(options.roleBackups ?? {}).map(([role, config]) => [role, { ...config, model: config.model ?? (config.cli === "claude" ? CLAUDE_MODELS[role] : CODEX_DEFAULTS[role]) }]));
  const needed = new Set([...Object.values(clis), ...Object.values(backupConfigs).map(config => config.cli)]);
  const workers = {};
  const constructors = {};
  if (needed.has("codex")) {
    const launcher = await resolveCodexCommand({ explicitCommand: options["codex-command"] ?? options["codex-exe"] });
    await preflightCodex(launcher);
    constructors.codex = overrides => new CodexWorker({ stateDir, workspace, launcher, windowsSandbox: options["codex-windows-sandbox"], additionalWritableDirs, roleOverrides: overrides });
    workers.codex = constructors.codex();
  }
  if (needed.has("claude")) {
    const claudeCommand = options["claude-command"] ?? "claude";
    await preflightClaude(claudeCommand);
    constructors.claude = overrides => new ClaudeWorker({ stateDir, workspace, claudeCommand, additionalWritableDirs, roleOverrides: overrides });
    workers.claude = constructors.claude();
  }
  const backups = Object.fromEntries(Object.entries(backupConfigs).map(([role, config]) => [role, constructors[config.cli]({ [role]: config })]));
  return new RoleRoutedOrchestrator(Object.fromEntries(ORCHESTRATOR_ROLES.map((role) => [role, workers[clis[role]]])), {
    backups, backupConfigs, clis, onEvent,
    beforeFallback: async (role, args) => {
      if (role !== "qa") return;
      const packet = args[0];
      await assertQaPacketFresh(workspace, packet);
      const evidence = await collectGitEvidence({ workspace, task: packet.task, baselineSha: packet.baselineSha });
      if (evidence.scope.status !== "PASS" || JSON.stringify(evidence.changedFiles) !== JSON.stringify(packet.changedFiles) || evidence.diff.text !== packet.diff.text) {
        throw new Error("Cannot retry QA on a backup: workspace scope, HEAD or diff changed during the primary review");
      }
    },
  });
}
