import type { ParallelRound, ParallelTaskStage, TaskBoard } from "@shared/types";
import { normalizeTitle } from "@shared/task-board";

/** How each stage of a parallel round's task reads in Overview › Progress. */
export const PARALLEL_STAGE_LABEL: Record<ParallelTaskStage, string> = {
  starting: "Starting",
  assessment: "Assessment",
  implementation: "Implementation",
  qa: "QA",
  correction: "Correction",
  "waiting-limit": "Waiting for limit",
  paused: "Paused",
  working: "Working",
  approved: "Approved, merging",
  merged: "Done",
  failed: "Failed",
  "merge-failed": "Merge failed",
  stopped: "Stopped",
};

/** Automation cycle boxes a round's tasks are in right now (a task's engine stage maps to the box of the same name). */
export function parallelCycleKeys(round: ParallelRound | null | undefined): Set<string> {
  const keys = new Set<string>();
  for (const t of round?.tasks ?? []) {
    if (t.stage === "assessment" || t.stage === "implementation" || t.stage === "qa" || t.stage === "correction") keys.add(t.stage);
  }
  return keys;
}

/** The cycle strip's stage text during a round, e.g. "Parallel round 1 · 2 tasks: Implementation 1, QA 1". */
export function parallelRoundSummary(round: ParallelRound): string {
  const counts = new Map<ParallelTaskStage, number>();
  for (const t of round.tasks) counts.set(t.stage, (counts.get(t.stage) ?? 0) + 1);
  // Stages in cycle order (the label table's order), whatever order the tasks list them in.
  const parts = (Object.keys(PARALLEL_STAGE_LABEL) as ParallelTaskStage[])
    .filter((stage) => counts.has(stage))
    .map((stage) => `${PARALLEL_STAGE_LABEL[stage]} ${counts.get(stage)}`);
  const n = round.tasks.length;
  return `Parallel round ${round.round} · ${n} ${n === 1 ? "task" : "tasks"}${parts.length ? `: ${parts.join(", ")}` : ""}`;
}

/**
 * Whether a plan checklist item is being worked on, for the Implementation plan card. With a Task board, an open
 * item in its In progress column (by phase and title); without one, the old guess: the item's title contains the
 * start of the current task's name.
 */
export function planItemActive(
  item: { title: string; completed: boolean },
  phase: number,
  board: TaskBoard | null | undefined,
  activeTitle: string | null,
): boolean {
  if (item.completed) return false;
  if (board) {
    const title = normalizeTitle(item.title);
    return board.items.some((b) => b.column === "in-progress" && b.phase.number === phase && normalizeTitle(b.title) === title);
  }
  return activeTitle != null && item.title.toLowerCase().includes(activeTitle.toLowerCase().slice(0, 24));
}
