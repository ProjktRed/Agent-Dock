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
  }
  const orchestrator = qaCli?.kind === "claude" ? "claude" : "codex";
  args.push("--orchestrator", orchestrator);
  if (qaCli && qaCli.location && qaCli.location !== qaCli.kind) {
    args.push(orchestrator === "claude" ? "--claude-command" : "--codex-exe", qaCli.location);
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
