import type { Agent, CliConnection, LimitsState, MaxLimits, TaskMode, WorkflowSettings } from "./types";

export const TASK_MODES: { mode: TaskMode; label: string; desc: string }[] = [
  { mode: "eco", label: "Eco", desc: "Small tasks: one file each, implementation and tests separate, new files under about 200 lines, up to 3 files read. Saves usage; suits local models." },
  { mode: "standard", label: "Standard", desc: "One plan item per task, code and tests together: up to 10 files, about 800 new lines and 10 files read. For Pro, Max or API plans, or a large local model." },
  { mode: "max", label: "Max", desc: "No size limits: a task may cover several plan items. Set your own limits under Max limits. Uses the most usage per task." },
];

export const NO_MAX_LIMITS: MaxLimits = { files: 0, newLines: 0, readFiles: 0, timeoutMinutes: 0 };

/** Standard's suggestion for a local model starts at this context size (smaller contexts slow down as they fill). */
export const STANDARD_LOCAL_CONTEXT = 131_072;

export function taskModeOf(workflow: Partial<WorkflowSettings>): TaskMode {
  return workflow.taskMode === "standard" || workflow.taskMode === "max" ? workflow.taskMode : "eco";
}

/** Max mode's limits, each a whole number (0 = no limit). */
export function maxLimitsOf(workflow: Partial<WorkflowSettings>): MaxLimits {
  const whole = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);
  const limits = { ...NO_MAX_LIMITS, ...workflow.maxLimits };
  return { files: whole(limits.files), newLines: whole(limits.newLines), readFiles: whole(limits.readFiles), timeoutMinutes: whole(limits.timeoutMinutes) };
}

/**
 * The mode to suggest for the Implementation agent: Standard for a cloud CLI on a Pro, Max or API plan,
 * or a local model with a large context; Eco otherwise. Never Max, and never applied by itself.
 */
export function suggestTaskMode(input: { implementation?: Agent | null; clis: CliConnection[]; limits?: LimitsState | null }): { mode: TaskMode; reason: string } {
  const agent = input.implementation;
  if (!agent) return { mode: "eco", reason: "No Implementation agent is enabled." };
  const cli = input.clis.find((c) => c.id === agent.cliId);
  const local = (cli?.kind === "cline" || cli?.kind === "opencode") && (agent.provider === "llamacpp" || agent.provider === "ollama");
  if (local) {
    const big = agent.contextTokens >= STANDARD_LOCAL_CONTEXT;
    return big
      ? { mode: "standard", reason: `The local model has a ${Math.round(agent.contextTokens / 1024)}K context.` }
      : { mode: "eco", reason: `The local model has a ${Math.round(agent.contextTokens / 1024)}K context; small tasks keep it fast.` };
  }
  if (agent.provider === "openai") return { mode: "standard", reason: "The Implementation agent uses a cloud API, billed per token (keep a spend budget)." };
  const limits = cli?.kind === "codex" ? input.limits?.codex : cli?.kind === "claude" ? input.limits?.claude : null;
  const plan = (limits?.plan ?? "").toLowerCase();
  if (/\b(pro|max|team|enterprise|business)\b/.test(plan)) return { mode: "standard", reason: `The ${limits!.plan} plan has room for whole plan items.` };
  if (limits && !limits.ok && /no plan limits/i.test(limits.error ?? "")) return { mode: "standard", reason: "An API-key account (billed per token; keep a spend budget)." };
  return { mode: "eco", reason: plan ? `The ${limits!.plan} plan: small tasks save usage.` : "The plan is not known yet: small tasks save usage." };
}
