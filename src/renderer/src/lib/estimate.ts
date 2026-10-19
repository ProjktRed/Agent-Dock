import type { RunReport } from "@shared/types";

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
