import type { Agent, CliConnection, EngineTuning, Project, Role, Settings, WorkflowRole, WorkflowSettings } from "@shared/types";
import path from "node:path";
import type { EngineRoleEntry } from "@shared/api";
import { DEFAULT_SETTINGS } from "@shared/defaults";
import { SECOND_OPINION_ROLE_ID } from "@shared/workflow-templates";
import { maxLimitsOf, taskModeOf } from "@shared/task-mode";

export type EngineRole = Exclude<Role, "custom">;

export function effectiveWorkflow(settings: Settings, project: Project): WorkflowSettings {
  return { ...settings.workflow, ...project.workflowOverrides };
}

/** The agent filling a workflow role for a project: project override first, then the first enabled agent with that role. */
/** --prices JSON for the engine: valid rows only, or null when the table is empty. */
export function pricesArg(prices: WorkflowSettings["prices"]): string | null {
  const usd = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : 0);
  const rows = (prices ?? []).filter((p) => p && typeof p.model === "string" && p.model.trim())
    .map((p) => ({ model: p.model.trim(), input: usd(p.input), cachedInput: usd(p.cachedInput), output: usd(p.output) }));
  return rows.length ? JSON.stringify(rows) : null;
}

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

/** Longest custom instructions per agent (engine/src/task-handoff-skill.mjs NOTE_CHARS). */
export const AGENT_NOTES_MAX_CHARS = 4_000;

/** Cline CLI --thinking levels (engine --cline-thinking). */
export const CLINE_THINKING = ["none", "low", "medium", "high", "xhigh"];

function opencodeConsoleBaseUrl(location: string): string | null {
  try {
    const url = new URL(location);
    if (url.hostname.toLowerCase() !== "opencode.ai" || !/^\/inference(?:\/|$)/i.test(url.pathname)) return null;
    if (/^\/inference\/v1\/?$/i.test(url.pathname)) return "https://opencode.ai/inference/openai/v1";
    return location.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/** Engine flags for loop limits that differ from the engine defaults (passed only with guardrails off). */
export const TUNING_FLAGS: [keyof EngineTuning, string][] = [
  ["elevationAfter", "--elevation-after"],
  ["resolverMaxStrategies", "--resolver-max-strategies"],
  ["maxCorrections", "--max-corrections"],
  ["taskMaxFiles", "--task-max-files"],
  ["taskMaxNewLines", "--task-max-new-lines"],
  ["taskMaxReadFiles", "--task-max-read-files"],
];

/** The agent running a workflow role: an enabled agent with role "custom" whose customRole is the role's id (or its name). */
export function agentForWorkflowRole(role: WorkflowRole, agents: Agent[]): Agent | null {
  const name = role.name.trim().toLowerCase();
  return agents.find((a) => a.role === "custom" && a.enabled && (a.customRole === role.id || a.customRole?.trim().toLowerCase() === name)) ?? null;
}

export interface EngineLaunchPlan {
  args: string[];
  roles: EngineRoleEntry[];
  /** Skill names assigned per engine role (engine-bundled skills excluded); resolved and written to --skills-file at start. */
  skills: Record<string, string[]>;
  autoSkills: string[];
  autoAllImported: boolean;
  /** Each role agent's custom instructions, keyed like skills; written to the same --skills-file. */
  notes: Record<string, string>;
  /** Block the start. */
  problems: string[];
  /** Shown, but the start goes ahead (engine guardrails off). */
  warnings: string[];
  summary: { implementation: string; orchestrator: string };
}

/**
 * Translate app configuration into the engine CLI (engine/src/cli.mjs) flags.
 * Each orchestrator role may use its own CLI (--<role>-cli). With engine guardrails on,
 * models must belong to that role's CLI; with guardrails off model checks become warnings.
 * Implementation runs through Cline, OpenCode, Codex or Claude Code. Enabled workflow roles
 * with an agent are passed as a roles file; loop limits only with guardrails off.
 */
export function buildEngineArgs(input: {
  project: Project;
  agents: Agent[];
  clis: CliConnection[];
  settings: Settings;
  roles?: WorkflowRole[];
  protectedRoots?: string[];
}): EngineLaunchPlan {
  const { project, agents, clis, settings, roles: workflowRoles = [] } = input;
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
  else if (!implCli || !["cline", "opencode", "codex", "claude"].includes(implCli.kind)) problems.push(`Implementation agent “${impl.name}” must use Cline, OpenCode, Codex CLI or Claude Code.`);
  else if ((implCli.kind === "cline" || implCli.kind === "opencode") && !impl.provider) problems.push(`Implementation agent “${impl.name}” has no provider selected.`);

  const qa = agentForRole("qa", project, agents);
  const qaCli = cliOf(qa);
  if (!qa || !qa.enabled) problems.push("No enabled QA agent.");
  else if (!orchestratorKind(qa)) problems.push(`QA agent “${qa.name}” must use Codex CLI or Claude Code.`);

  const assessment = agentForRole("assessment", project, agents);
  const elevation = agentForRole("elevation", project, agents);
  const automaticElevation = workflow.automaticElevation && Boolean(elevation?.enabled);
  const orchestrator = orchestratorKind(qa) ?? "codex";
  const usedConnections = new Map<"codex" | "claude", CliConnection>();
  const useConnection = (agent: Agent, label: string) => {
    const conn = cliOf(agent);
    const kind = orchestratorKind(agent);
    if (!conn || !kind) return;
    const previous = usedConnections.get(kind);
    const command = (connection: CliConnection) => {
      const value = connection.location.trim() || kind;
      return process.platform === "win32" ? path.normalize(value).toLowerCase() : value;
    };
    if (previous && command(previous) !== command(conn)) {
      problems.push(`${label} and another role select different executables for ${kind}. Use the same CLI connection for roles on that CLI.`);
    } else usedConnections.set(kind, conn);
  };
  if (qa) useConnection(qa, "QA");

  // A CI fix run: the failed log goes before the objective, for this start only.
  const objective = project.ciNote ? `${project.ciNote}

Project objective:
${project.objective}` : project.objective;
  const args = ["--workspace", project.path, "--objective", objective, "--state-dir", project.stateDir];
  const unattended = workflow.unattended === true;
  // Unattended: never waits at a task boundary and never runs with the tool guard off.
  args.push('--auto-continue', String(unattended || workflow.autoContinue));
  const protectedPaths = settings.safety?.protectedPaths;
  if (!Array.isArray(protectedPaths) || protectedPaths.some(p => typeof p !== "string" || !p.trim() || /[\0\r\n]/.test(p))) problems.push("Protected paths must be nonempty paths.");
  else args.push("--protected-paths", JSON.stringify([...new Set([...protectedPaths, project.stateDir, ...(input.protectedRoots ?? [])])]));
  if (impl && (implCli?.kind === "cline" || implCli?.kind === "opencode") && impl.provider) {
    const selectedProviderConn = impl.provider === "openai" && impl.providerCliId ? clis.find((c) => c.id === impl.providerCliId) : undefined;
    const providerConn = impl.provider === "openai"
      ? selectedProviderConn
        ? selectedProviderConn.kind === "openai" ? selectedProviderConn : undefined
        : impl.providerCliId ? undefined : clis.find((c) => c.kind === "openai")
      : clis.find((c) => c.kind === impl.provider);
    if (implCli.kind === "opencode" && implCli.location && implCli.location !== "opencode") args.push("--opencode-exe", implCli.location);
    if (impl.provider === "openai" && !providerConn) guard(`Implementation agent “${impl.name}” has no valid OpenAI-compatible provider connection.`);
    const opencodeBaseUrl = impl.provider === "openai" && providerConn ? opencodeConsoleBaseUrl(providerConn.location) : null;
    const providerId = impl.provider === "openai" && providerConn && /^https:\/\/openrouter\.ai\/api\/v1\/?$/i.test(providerConn.location)
      ? "openrouter"
      : opencodeBaseUrl ? "opencode" : impl.provider;
    args.push("--provider", providerId);
    // Local servers have no model everyone has: the agent must name one.
    if (impl.model.trim()) args.push("--model", impl.model.trim());
    else problems.push(`Choose a model for ${impl.name} in Agents.`);
    if ((impl.provider === "llamacpp" || impl.provider === "ollama") && !providerConn) problems.push(`${impl.name} uses ${impl.provider === "ollama" ? "Ollama" : "llama.cpp"}, but no such connection exists. Add it in CLIs.`);
    if (implCli.kind === "opencode") args.push("--worker", "opencode");
    args.push("--cline-context-tokens", String(impl.contextTokens));
    args.push("--cline-max-output-tokens", String(impl.maxOutputTokens));
    args.push("--timeout-seconds", String(impl.timeoutSeconds));
    if (impl.reasoning && CLINE_THINKING.includes(impl.reasoning)) args.push("--cline-thinking", impl.reasoning);
    if (impl.provider === "openai" && providerConn) {
      const baseUrl = opencodeBaseUrl ?? providerConn.location.replace(/\/+$/, "");
      args.push("--provider-base-url", baseUrl, "--provider-api-key-env", "AGENT_DOCK_PROVIDER_KEY");
      if (!providerConn.hasSecret) guard(`Implementation provider “${providerConn.name}” has no saved API key.`);
    }
    // The connection's address: llama.cpp and Ollama may listen on any port.
    if (impl.provider === "llamacpp" && providerConn?.location.trim()) args.push("--llamacpp-url", providerConn.location.trim());
    if (impl.provider === "ollama" && providerConn?.location.trim()) args.push("--ollama-url", providerConn.location.trim().replace(/\/+$/, "").replace(/\/v1$/, ""));
    if (impl.provider === "llamacpp" && providerConn?.modelsDir) args.push("--llamacpp-models-dir", providerConn.modelsDir);
    if (impl.provider === "llamacpp" && settings.advanced.llamaCppLauncher.trim()) args.push("--llamacpp-launcher", settings.advanced.llamaCppLauncher.trim());
    const collected = providerConn?.collected?.models ?? [];
    if (collected.length && !collected.some((m) => m.id === impl.model)) {
      guard(`Implementation model “${impl.model}” is not in the list collected from ${providerConn!.name}. Pick a model in Agents, or refresh the list in CLIs › Models.`);
    }
  }
  const implKind = implCli?.kind === "codex" || implCli?.kind === "claude" ? implCli.kind : null;
  if (impl && implKind) {
    useConnection(impl, "Implementation");
    args.push("--implementation-cli", implKind, "--timeout-seconds", String(impl.timeoutSeconds));
    const model = impl.model.trim();
    // The implementation worker passes the model as given (no mapping of Codex default labels on Claude).
    const wrongModel = Boolean(model) && (implKind === "claude" ? /^(gpt-|o\d|codex-)/i.test(model) : wrongProviderModel("codex", model));
    if (wrongModel) guard(`${impl.name}: “${model}” is not a ${implKind === "claude" ? "Claude Code" : "Codex"} model.`);
    if (model && !(guarded && wrongModel)) args.push("--implementation-model", model);
    if (impl.reasoning && impl.reasoning !== "none") args.push("--implementation-effort", impl.reasoning);
    args.push("--implementation-fast", String(Boolean(impl.fast)));
  }
  args.push("--orchestrator", orchestrator);

  // Per-role CLI, model, effort and speed. Resolver follows the Assessment agent (the app has no Resolver role).
  const roles: [string, string[], Agent | null][] = [
    ["QA", ["qa"], qa],
    ["Assessment", ["assessment", "resolver"], assessment],
    ["Elevation", ["elevate"], elevation?.enabled ? elevation : null],
  ];
  const usedKinds = new Set<"codex" | "claude">([orchestrator]);
  if (implKind) usedKinds.add(implKind);
  for (const [label, flags, agent] of roles) {
    const kind = orchestratorKind(agent);
    if (!agent || !kind) continue;
    useConnection(agent, label);
    if (kind !== orchestrator) {
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
    if (agent.backupAgentId) {
      const backup = agents.find(a => a.id === agent.backupAgentId);
      const backupKind = orchestratorKind(backup ?? null);
      if (!backup || !backup.enabled || backup.id === agent.id || !backupKind || backupKind === kind) {
        problems.push(`${label} backup must be an enabled, different agent on the other orchestrator CLI.`);
        continue;
      }
      const backupModel = backup.model.trim();
      if (backupModel && wrongProviderModel(backupKind, backupModel)) {
        guard(`${label} backup “${backup.name}”: “${backupModel}” is not a ${backupKind === "claude" ? "Claude Code" : "Codex"} model.`);
        if (guarded) continue;
      }
      usedKinds.add(backupKind);
      useConnection(backup, `${label} backup`);
      for (const flag of flags) {
        args.push(`--${flag}-backup-cli`, backupKind);
        if (backupModel) args.push(`--${flag}-backup-model`, backupModel);
        if (backup.reasoning) args.push(`--${flag}-backup-effort`, backup.reasoning);
        args.push(`--${flag}-backup-fast`, String(Boolean(backup.fast)));
      }
    }
  }
  // Workflow roles: read-only reviews run by the agent assigned to each role (Codex or Claude Code).
  const roleEntries: EngineRoleEntry[] = [];
  for (const role of workflowRoles.filter((r) => r.enabled)) {
    const secondOpinion = role.id === SECOND_OPINION_ROLE_ID;
    if (secondOpinion && (role.stage !== "before-qa" || !role.gate || !role.instructions.trim())) {
      problems.push("Second-opinion QA must be a before-QA gate with review instructions.");
      continue;
    }
    const roleProblem = (message: string) => (secondOpinion ? problems : warnings).push(message);
    if (!role.instructions.trim()) { warnings.push(`Workflow role “${role.name}” has no instructions and is skipped.`); continue; }
    const agent = agentForWorkflowRole(role, agents);
    const kind = orchestratorKind(agent);
    if (!agent) { roleProblem(`Workflow role “${role.name}” has no enabled agent (Workflow › ${role.name} › Runs on).`); continue; }
    if (!kind) { roleProblem(`Workflow role “${role.name}”: agent “${agent.name}” must use Codex CLI or Claude Code.`); continue; }
    if (secondOpinion && kind === orchestrator) { problems.push("Second-opinion QA must use a different CLI from the QA agent."); continue; }
    const model = agent.model.trim();
    if (model && wrongProviderModel(kind, model)) {
      guard(`${agent.name}: “${model}” is not a ${kind === "claude" ? "Claude Code" : "Codex"} model.`);
      if (guarded) continue;
    }
    usedKinds.add(kind);
    useConnection(agent, role.name);
    roleEntries.push({ id: role.id, name: role.name, stage: role.stage, gate: role.gate, ...(role.stage === "before-qa" && role.gate && role.fix ? { fix: true } : {}), cli: kind, ...(model ? { model } : {}), ...(agent.reasoning ? { effort: agent.reasoning } : {}), fast: Boolean(agent.fast), instructions: role.instructions });
  }
  if (roleEntries.length) args.push("--roles-file", path.join(project.stateDir, "workflow-roles.json"));
  // Assigned skills per engine role. bounded-task-handoff is the engine's own and always included.
  const skills: Record<string, string[]> = {};
  const notes: Record<string, string> = {};
  const assign = (key: string, agent: Agent | null | undefined) => {
    const names = (agent?.skills ?? []).filter((name) => name !== "bounded-task-handoff");
    if (names.length) skills[key] = [...new Set(names)];
    const text = agent?.instructions?.trim();
    if (text) {
      if (text.length > AGENT_NOTES_MAX_CHARS) problems.push(`Custom instructions for ${agent!.name} are longer than ${AGENT_NOTES_MAX_CHARS.toLocaleString("en-US")} characters; shorten them.`);
      else notes[key] = text;
    }
  };
  assign("implementation", impl);
  assign("qa", qa);
  assign("assessment", assessment);
  assign("resolver", assessment);
  if (elevation?.enabled) assign("elevate", elevation);
  for (const entry of roleEntries) assign(`role:${entry.id}`, agentForWorkflowRole(workflowRoles.find((r) => r.id === entry.id)!, agents));
  // "When relevant" skills: Assessment sees their descriptions and picks per task; always-assigned ones are not repeated.
  const autoSkills = [...new Set((impl?.autoSkills ?? []).filter((name) => name !== "bounded-task-handoff" && !skills.implementation?.includes(name)))];
  const autoAllImported = Boolean(impl) && impl!.autoAllImported !== false;
  if (Object.keys(skills).length || Object.keys(notes).length || autoSkills.length || autoAllImported) args.push("--skills-file", path.join(project.stateDir, "assigned-skills.json"));
  // Parallel tasks. Unattended mode too: the run keeps one budget for all its tasks, whose engines run without
  // limits of their own. On a local model server (0.38) the engine runs at most as many tasks as the server
  // answers at once: llama.cpp's slots, or the requests at once set on the Ollama connection.
  const parallel = Math.min(4, Math.max(1, Math.floor(Number(workflow.parallelTasks) || 1)));
  if (parallel > 1) {
    args.push("--parallel", String(parallel));
    const local = (implCli?.kind === "cline" || implCli?.kind === "opencode") && impl?.provider !== "openai";
    if (local && impl?.provider === "ollama") {
      const at = Math.max(1, Math.floor(Number(clis.find((c) => c.kind === "ollama")?.parallelRequests) || 1));
      args.push("--ollama-parallel", String(at));
      if (at < parallel) warnings.push(`Ollama answers ${at} request${at === 1 ? "" : "s"} at once as set on its connection (CLIs › Ollama, OLLAMA_NUM_PARALLEL), so at most ${at} task${at === 1 ? "" : "s"} run at once.`);
    }
  }
  // Task size: eco uses the tunable sizing below; standard its fixed sizing; max only the limits you set.
  const taskMode = taskModeOf(workflow);
  if (taskMode !== "eco") args.push("--task-mode", taskMode);
  if (taskMode !== "eco" && workflow.stepDown === false) args.push("--step-down", "false");
  if (taskMode === "max") {
    const max = maxLimitsOf(workflow);
    if (max.files) args.push("--task-max-files", String(max.files));
    if (max.newLines) args.push("--task-max-new-lines", String(Math.max(10, max.newLines)));
    if (max.readFiles) args.push("--task-max-read-files", String(max.readFiles));
    // Max limits' timeout replaces the Implementation agent's own.
    const at = args.indexOf("--timeout-seconds");
    if (max.timeoutMinutes && at >= 0) args[at + 1] = String(max.timeoutMinutes * 60);
  }
  // Loop limits: fixed with guardrails on (engine defaults); passed when they differ with guardrails off.
  if (!guarded) {
    for (const [key, flag] of TUNING_FLAGS) {
      if (taskMode !== "eco" && key.startsWith("taskMax")) continue;
      const value = settings.tuning?.[key];
      if (typeof value === "number" && value !== DEFAULT_SETTINGS.tuning[key]) args.push(flag, String(value));
    }
  }
  // Custom executable locations for every orchestrator CLI in use.
  for (const [kind, conn] of usedConnections) {
    if (conn?.location && conn.location !== kind) args.push(kind === "claude" ? "--claude-command" : "--codex-exe", conn.location);
  }
  if (project.pendingTaskFile) args.push("--task", project.pendingTaskFile);
  args.push("--sol-reassessment", String(automaticElevation));
  const retentionDays = input.settings.general.retentionDays ?? DEFAULT_SETTINGS.general.retentionDays ?? 30;
  args.push("--retention-days", String(Number.isFinite(retentionDays) && retentionDays >= 0 ? retentionDays : 30));
  args.push("--tool-guard", String(unattended || workflow.toolGuard));
  const sv = { ...DEFAULT_SETTINGS.workflow.supervisor!, ...workflow.supervisor };
  const count = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : 0);
  args.push("--supervisor", ["off", "alert", "pause", "stop"].includes(sv.mode) ? sv.mode : "alert");
  if (sv.mode !== "off") {
    args.push("--sv-stall-minutes", String(count(sv.stallMinutes)), "--sv-repeat-failures", String(Math.floor(count(sv.repeatFailures))), "--sv-refusals", String(Math.floor(count(sv.refusals))),
      "--sv-tokens-per-task", String(Math.round(count(sv.millionTokensPerTask) * 1_000_000)), "--sv-plan-drift", String(Math.floor(count(sv.planDrift))),
      "--sv-scope-paths", String(Math.floor(count(sv.scopePaths))), "--sv-digest-hours", String(count(sv.digestHours)));
    const review = sv.review === "propose" || sv.review === "act" ? sv.review : "off";
    args.push("--supervisor-review", review);
    if (review !== "off") {
      if (sv.reviewer && sv.reviewer !== "auto") args.push("--supervisor-reviewer", sv.reviewer);
      if (sv.reviewerModel?.trim()) args.push("--supervisor-model", sv.reviewerModel.trim());
      if (sv.reviewer === "local") {
        if (!sv.reviewerBaseUrl?.trim()) problems.push("The local Supervisor reviewer needs a server URL.");
        else args.push("--supervisor-base-url", sv.reviewerBaseUrl.trim());
        if (!sv.reviewerModel?.trim()) problems.push("The local Supervisor reviewer needs a model name.");
      }
      args.push("--supervisor-may-defer", String(sv.mayDefer === true), "--sv-review-max", String(Math.floor(count(sv.reviewMax ?? 6))),
        "--sv-plan-proposals", String(sv.planProposals !== false));
    }
  }
  if (unattended) {
    const limits = { ...DEFAULT_SETTINGS.workflow.unattendedLimits, ...workflow.unattendedLimits };
    const whole = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : 0);
    if (!(whole(limits.maxCorrections) >= 1)) problems.push("Unattended mode needs a correction limit of at least 1.");
    // After the tuning flags, so the unattended correction limit wins.
    args.push("--unattended", "true", "--max-tasks", String(Math.floor(whole(limits.maxTasks))), "--max-hours", String(whole(limits.maxHours)),
      "--max-elevations", String(Math.floor(whole(limits.maxElevations))), "--max-corrections", String(Math.max(1, Math.floor(whole(limits.maxCorrections)))),
      "--max-tokens", String(Math.round(whole(limits.maxMillionTokens) * 1_000_000)), "--max-cost", String(whole(limits.maxCostUsd)),
      "--max-tokens-day", String(Math.round(whole(limits.maxMillionTokensDay) * 1_000_000)), "--max-cost-day", String(whole(limits.maxCostUsdDay)));
  }
  const prices = pricesArg(workflow.prices);
  if (prices) args.push("--prices", prices);

  return {
    args,
    roles: roleEntries,
    skills,
    autoSkills,
    autoAllImported,
    notes,
    problems,
    warnings,
    summary: {
      implementation: impl ? (implKind ? `${impl.name} · ${implCli!.name} · ${impl.model || "CLI default"}` : `${impl.name} · Cline → ${impl.provider ?? "?"} · ${impl.model}`) : "none",
      orchestrator: qaCli ? `${qaCli.name} (${orchestrator})${usedKinds.size > 1 ? " + mixed roles" : ""}` : "none",
    },
  };
}
