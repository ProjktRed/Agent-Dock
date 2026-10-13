import { CloudImplementationWorker } from "./cloud-impl-worker.mjs";
import { CodexWorker } from "./codex-worker.mjs";
import { ClaudeWorker, preflightClaude } from "./claude-worker.mjs";
import { preflightCodex, resolveCodexCommand } from "./codex-command.mjs";
import { createRoleRunner, readRolesFile } from "./workflow-roles.mjs";

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

/** Custom workflow roles (--roles-file) and the runner for them; each CLI a role needs is preflighted once. */
export async function createRoles(options, { stateDir, workspace }) {
  const roles = await readRolesFile(options.rolesFile);
  if (!roles.length) return { roles, runRole: null };
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
  return { roles, runRole: createRoleRunner(workers) };
}

/** A failed startup git query, rethrown with git's own reason (e.g. "detected dubious ownership"). */
export function gitStartupError(error) {
  const reason = String(error?.stderr || error?.message || error).split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? 'unknown error';
  throw new Error(`git cannot read the workspace repository: ${reason}`);
}
