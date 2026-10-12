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
  /** Block the start. */
  problems: string[];
  /** Shown, but the start goes ahead (engine guardrails off). */
  warnings: string[];
  summary: { implementation: string; orchestrator: string };
}

/**
 * Translate app configuration into the engine CLI (engine/src/cli.mjs) flags.
 * With engine guardrails on (default) QA, Assessment, Resolver and Elevation share one orchestrator
 * CLI and models must belong to it. With guardrails off each role may use its own CLI
 * (--<role>-cli; the engine routes each role to its worker) and those checks become warnings.
 * Implementation always runs through Cline.
 */
export function buildEngineArgs(input: {
  project: Project;
  agents: Agent[];
  clis: CliConnection[];
  settings: Settings;
}): EngineLaunchPlan {
  const { project, agents, clis, settings } = input;
  const problems: string[] = [];
  const warnings: string[] = [];
  const guarded = settings.advanced.engineGuardrails !== false;
  /** A guardrail: blocks with guardrails on, warns with them off. */
  const guard = (message: string) => (guarded ? problems : warnings).push(message);
  const workflow = effectiveWorkflow(settings, project);
  const cliOf = (agent: Agent | null) => (agent ? clis.find((c) => c.id === agent.cliId) ?? null : null);
  const orchestratorKind = (agent: Agent | null) => {
    const kind = cliOf(agent)?.kind;
    return kind === "codex" || kind === "claude" ? kind : null;
  };

  if (!project.objective.trim()) problems.push("Set a project objective before starting.");

  const impl = agentForRole("implementation", project, agents);
  const implCli = cliOf(impl);
  if (!impl) problems.push("No enabled Implementation agent.");
  else if (!impl.enabled) problems.push(`Implementation agent “${impl.name}” is disabled.`);
  else if (implCli?.kind !== "cline") problems.push(`Implementation agent “${impl.name}” must use a Cline CLI connection (the engine implements only through Cline).`);
  else if (!impl.provider) problems.push(`Implementation agent “${impl.name}” has no local provider (llama.cpp or Ollama).`);

  const qa = agentForRole("qa", project, agents);
  const qaCli = cliOf(qa);
  if (!qa || !qa.enabled) problems.push("No enabled QA agent.");
  else if (!orchestratorKind(qa)) problems.push(`QA agent “${qa.name}” must use Codex CLI or Claude Code.`);

  const assessment = agentForRole("assessment", project, agents);
  const elevation = agentForRole("elevation", project, agents);
  const automaticElevation = workflow.automaticElevation && Boolean(elevation?.enabled);
  const orchestrator = orchestratorKind(qa) ?? "codex";

  const args = ["--workspace", project.path, "--objective", project.objective, "--state-dir", project.stateDir];
  if (impl && implCli?.kind === "cline" && impl.provider) {
    args.push("--provider", impl.provider, "--model", impl.model);
    args.push("--cline-context-tokens", String(impl.contextTokens));
    args.push("--cline-max-output-tokens", String(impl.maxOutputTokens));
    args.push("--timeout-seconds", String(impl.timeoutSeconds));
    if (impl.reasoning && CLINE_THINKING.includes(impl.reasoning)) args.push("--cline-thinking", impl.reasoning);
    const providerConn = clis.find((c) => c.kind === impl.provider);
    if (impl.provider === "llamacpp" && providerConn?.modelsDir) args.push("--llamacpp-models-dir", providerConn.modelsDir);
    if (impl.provider === "llamacpp" && settings.advanced.llamaCppLauncher.trim()) args.push("--llamacpp-launcher", settings.advanced.llamaCppLauncher.trim());
    const collected = providerConn?.collected?.models ?? [];
    if (collected.length && !collected.some((m) => m.id === impl.model)) {
      guard(`Implementation model “${impl.model}” is not in the list collected from ${providerConn!.name}. Pick a model in Agents, or refresh the list in CLIs › Models.`);
    }
  }
  args.push("--orchestrator", orchestrator);

  // Per-role CLI, model, effort and speed. Resolver follows the Assessment agent (the app has no Resolver role).
  const roles: [string, string[], Agent | null][] = [
    ["QA", ["qa"], qa],
    ["Assessment", ["assessment", "resolver"], assessment],
    ["Elevation", ["elevate"], elevation?.enabled ? elevation : null],
  ];
  const usedKinds = new Set<"codex" | "claude">([orchestrator]);
  for (const [label, flags, agent] of roles) {
    const kind = orchestratorKind(agent);
    if (!agent || !kind) continue;
    if (kind !== orchestrator) {
      guard(`${label} agent “${agent.name}” uses ${cliOf(agent)!.name} but QA uses ${qaCli?.name}: the engine is built to run one orchestrator CLI.`);
      if (guarded) continue;
      usedKinds.add(kind);
      for (const flag of flags) args.push(`--${flag}-cli`, kind);
    }
    const model = agent.model.trim();
    if (model && wrongProviderModel(kind, model)) {
      guard(`${agent.name}: “${model}” is not a ${kind === "claude" ? "Claude Code" : "Codex"} model.`);
      if (guarded) continue;
    }
    for (const flag of flags) {
      if (model) args.push(`--${flag}-model`, model);
      if (agent.reasoning) args.push(`--${flag}-effort`, agent.reasoning);
      args.push(`--${flag}-fast`, String(Boolean(agent.fast)));
    }
  }
  // Custom executable locations for every orchestrator CLI in use.
  for (const kind of usedKinds) {
    const conn = clis.find((c) => c.kind === kind);
    if (conn?.location && conn.location !== kind) args.push(kind === "claude" ? "--claude-command" : "--codex-exe", conn.location);
  }
  if (project.pendingTaskFile) args.push("--task", project.pendingTaskFile);
  args.push("--sol-reassessment", String(automaticElevation));
  args.push("--tool-guard", String(workflow.toolGuard));

  return {
    args,
    problems,
    warnings,
    summary: {
      implementation: impl ? `${impl.name} · Cline → ${impl.provider ?? "?"} · ${impl.model}` : "none",
      orchestrator: qaCli ? `${qaCli.name} (${orchestrator})${usedKinds.size > 1 ? " + mixed roles" : ""}` : "none",
    },
  };
}
