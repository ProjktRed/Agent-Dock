import { CodexWorker, useRoleOverrides } from "./codex-worker.mjs";
import { CLAUDE_MODELS, ClaudeWorker, preflightClaude } from "./claude-worker.mjs";
import { preflightCodex, resolveCodexCommand } from "./codex-command.mjs";
import { ORCHESTRATOR_ROLES } from "./loop-options.mjs";

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
  constructor(workers) {
    this.workers = workers;
  }

  get distinct() {
    return [...new Set(Object.values(this.workers))];
  }

  get activeCount() {
    return this.distinct.reduce((sum, worker) => sum + (worker.activeCount ?? 0), 0);
  }

  async assertIdle() {
    for (const worker of this.distinct) await worker.assertIdle();
  }

  assess(...args) { return this.workers.assessment.assess(...args); }
  review(...args) { return this.workers.qa.review(...args); }
  assessCorrection(...args) { return this.workers.assessment.assessCorrection(...args); }
  reassessManualReview(...args) { return this.workers.elevate.reassessManualReview(...args); }
  resolveBlocked(...args) { return this.workers.resolver.resolveBlocked(...args); }
}

/** Preflight every CLI a role needs and build the routed orchestrator. */
export async function buildMixedOrchestrator({ options, clis, stateDir, workspace, additionalWritableDirs = [] }) {
  const needed = new Set(Object.values(clis));
  const workers = {};
  if (needed.has("codex")) {
    const launcher = await resolveCodexCommand({ explicitCommand: options["codex-command"] ?? options["codex-exe"] });
    await preflightCodex(launcher);
    workers.codex = new CodexWorker({ stateDir, workspace, launcher, windowsSandbox: options["codex-windows-sandbox"], additionalWritableDirs });
  }
  if (needed.has("claude")) {
    const claudeCommand = options["claude-command"] ?? "claude";
    await preflightClaude(claudeCommand);
    workers.claude = new ClaudeWorker({ stateDir, workspace, claudeCommand, additionalWritableDirs });
  }
  return new RoleRoutedOrchestrator(Object.fromEntries(ORCHESTRATOR_ROLES.map((role) => [role, workers[clis[role]]])));
}
