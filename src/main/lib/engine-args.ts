import type { Agent, CliConnection, Project, Role, Settings, WorkflowSettings } from "@shared/types";

export type EngineRole = Exclude<Role, "custom">;

export function effectiveWorkflow(settings: Settings, project: Project): WorkflowSettings {
  return { ...settings.workflow, ...project.workflowOverrides };
}

/** The agent filling a workflow role for a project: project override first, then the first enabled agent with that role. */
export function agentForRole(role: EngineRole, project: Project, agents: Agent[]): Agent | null {
  const overrideId = project.roleOverrides[role];
  if (overrideId) {
    const chosen = agents.find((a) => a.id === overrideId);
    if (chosen) return chosen;
  }
  return agents.find((a) => a.role === role && a.enabled) ?? null;
}

/**
 * A model id that clearly belongs to the other orchestrator (e.g. a Claude alias on Codex).
 * Codex default labels are allowed on Claude: the engine maps them to the Claude defaults.
 */
export function wrongProviderModel(orchestrator: "codex" | "claude", model: string): boolean {
  const claudeLike = /^(claude-|sonnet|opus|haiku|fable|default$)/i.test(model);
  if (orchestrator === "codex") return claudeLike;
  return /^(gpt-|o\d|codex-)/i.test(model) && !["gpt-6.1-sol", "gpt-6-astra"].includes(model);
}

/** Cline CLI --thinking levels (engine --cline-thinking). */
export const CLINE_THINKING = ["none", "low", "medium", "high", "xhigh"];

export interface EngineLaunchPlan {
  args: string[];
  problems: string[];
  summary: { implementation: string; orchestrator: string };
}

/**
 * Translate app configuration into the engine CLI (engine/src/cli.mjs) flags.
 * The engine runs one orchestrator (codex or claude) for QA, Assessment, Resolver and Elevation,
 * so those roles must share a CLI. Implementation always runs through Cline.
 */
export function buildEngineArgs(input: {
  project: Project;
  agents: Agent[];
  clis: CliConnection[];
  settings: Settings;
}): EngineLaunchPlan {
  const { project, agents, clis, settings } = input;
  const problems: string[] = [];
  const workflow = effectiveWorkflow(settings, project);
  const cliOf = (agent: Agent | null) => (agent ? clis.find((c) => c.id === agent.cliId) ?? null : null);

  if (!project.objective.trim()) problems.push("Set a project objective before starting.");

  const impl = agentForRole("implementation", project, agents);
  const implCli = cliOf(impl);
  if (!impl) problems.push("No enabled Implementation agent.");
  else if (!impl.enabled) problems.push(`Implementation agent “${impl.name}” is disabled.`);
  else if (implCli?.kind !== "cline") problems.push(`Implementation agent “${impl.name}” must use a Cline CLI connection.`);
  else if (!impl.provider) problems.push(`Implementation agent “${impl.name}” has no local provider (llama.cpp or Ollama).`);

  const qa = agentForRole("qa", project, agents);
  const qaCli = cliOf(qa);
  if (!qa || !qa.enabled) problems.push("No enabled QA agent.");
  else if (!qaCli || !["codex", "claude"].includes(qaCli.kind)) problems.push(`QA agent “${qa.name}” must use Codex CLI or Claude Code.`);

  const assessment = agentForRole("assessment", project, agents);
  const assessmentCli = cliOf(assessment);
  if (assessment && assessmentCli && qaCli && assessmentCli.kind !== qaCli.kind) {
    problems.push("Assessment and QA must use the same orchestrator CLI: the engine runs one orchestrator for both.");
  }

  const elevation = agentForRole("elevation", project, agents);
  const automaticElevation = workflow.automaticElevation && Boolean(elevation?.enabled);

  const args = ["--workspace", project.path, "--objective", project.objective, "--state-dir", project.stateDir];
  if (impl && implCli?.kind === "cline" && impl.provider) {
    args.push("--provider", impl.provider, "--model", impl.model);
    args.push("--cline-context-tokens", String(impl.contextTokens));
    args.push("--cline-max-output-tokens", String(impl.maxOutputTokens));
    args.push("--timeout-seconds", String(impl.timeoutSeconds));
    if (impl.reasoning && CLINE_THINKING.includes(impl.reasoning)) args.push("--cline-thinking", impl.reasoning);
    const providerConn = clis.find((c) => c.kind === impl.provider);
    if (impl.provider === "llamacpp" && providerConn?.modelsDir) args.push("--llamacpp-models-dir", providerConn.modelsDir);
    const collected = providerConn?.collected?.models ?? [];
    if (collected.length && !collected.some((m) => m.id === impl.model)) {
      problems.push(`Implementation model “${impl.model}” is not in the list collected from ${providerConn!.name}. Pick a model in Agents, or refresh the list in CLIs › Models.`);
    }
  }
  const orchestrator = qaCli?.kind === "claude" ? "claude" : "codex";
  args.push("--orchestrator", orchestrator);
  if (qaCli && qaCli.location && qaCli.location !== qaCli.kind) {
    args.push(orchestrator === "claude" ? "--claude-command" : "--codex-exe", qaCli.location);
  }
  // Per-role model, effort and speed. Resolver follows the Assessment agent (the app has no Resolver role).
  const roles: [string[], Agent | null][] = [[["qa"], qa], [["assessment", "resolver"], assessment], [["elevate"], elevation?.enabled ? elevation : null]];
  for (const [flags, agent] of roles) {
    if (!agent || cliOf(agent)?.kind !== orchestrator) continue;
    const model = agent.model.trim();
    if (model && wrongProviderModel(orchestrator, model)) {
      problems.push(`${agent.name}: “${model}” is not a ${orchestrator === "claude" ? "Claude Code" : "Codex"} model. Pick a model in Agents.`);
      continue;
    }
    for (const flag of flags) {
      if (model) args.push(`--${flag}-model`, model);
      if (agent.reasoning) args.push(`--${flag}-effort`, agent.reasoning);
      args.push(`--${flag}-fast`, String(Boolean(agent.fast)));
    }
  }
  if (elevation?.enabled && qaCli && cliOf(elevation) && cliOf(elevation)!.kind !== orchestrator) {
    problems.push(`Elevation agent “${elevation.name}” must use the same orchestrator CLI as QA (${qaCli.name}).`);
  }
  if (project.pendingTaskFile) args.push("--task", project.pendingTaskFile);
  args.push("--sol-reassessment", String(automaticElevation));
  args.push("--tool-guard", String(workflow.toolGuard));

  return {
    args,
    problems,
    summary: {
      implementation: impl ? `${impl.name} · Cline → ${impl.provider ?? "?"} · ${impl.model}` : "none",
      orchestrator: qaCli ? `${qaCli.name} (${orchestrator})` : "none",
    },
  };
}
