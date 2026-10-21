import type { RunReport, TaskMode } from "@shared/types";

export interface PlanEstimate { tasks: number; hours: number; tokens: number; costUsd: number; basisTasks: number }

/**
 * Plan estimate before Start: the plan's remaining items at this project's own pace, from the recent
 * runs that approved tasks (hours, counted tokens and spend per approved task). One plan item is
 * counted as one task, so it is a rough guide. Null without history to go on.
 */
export function planEstimate(remaining: number, runs: RunReport[], recent = 20): PlanEstimate | null {
  if (!(remaining > 0)) return null;
  const basis = runs.slice(0, recent).filter((r) => r.tasksApproved > 0);
  const tasks = basis.reduce((sum, r) => sum + r.tasksApproved, 0);
  if (!tasks) return null;
  const per = (pick: (r: RunReport) => number) => basis.reduce((sum, r) => sum + (pick(r) || 0), 0) / tasks;
  return {
    tasks: remaining,
    hours: per((r) => r.hours) * remaining,
    tokens: per((r) => r.usage?.tokens ?? 0) * remaining,
    costUsd: per((r) => r.usage?.costUsd ?? 0) * remaining,
    basisTasks: tasks,
  };
}

/**
 * The same estimate per task size, from runs in each mode that checked off plan items (0.35 on):
 * hours, tokens and spend per finished plan item. Runs from before 0.35 have no item count and are left out.
 */
export function modeEstimates(remaining: number, runs: RunReport[], recent = 40): Partial<Record<TaskMode, PlanEstimate>> {
  const out: Partial<Record<TaskMode, PlanEstimate>> = {};
  if (!(remaining > 0)) return out;
  for (const mode of ["eco", "standard", "max"] as const) {
    const basis = runs.slice(0, recent).filter((r) => (r.taskMode ?? "eco") === mode && (r.planItems ?? 0) > 0);
    const items = basis.reduce((sum, r) => sum + (r.planItems ?? 0), 0);
    if (!items) continue;
    const per = (pick: (r: RunReport) => number) => basis.reduce((sum, r) => sum + (pick(r) || 0), 0) / items;
    out[mode] = { tasks: remaining, hours: per((r) => r.hours) * remaining, tokens: per((r) => r.usage?.tokens ?? 0) * remaining, costUsd: per((r) => r.usage?.costUsd ?? 0) * remaining, basisTasks: basis.reduce((sum, r) => sum + r.tasksApproved, 0) };
  }
  return out;
}
