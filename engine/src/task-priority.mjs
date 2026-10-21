import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { readImplementationProgress } from "./implementation-progress.mjs";
import { readDeferred } from "./supervisor-review.mjs";

/**
 * The Task board's priority order: <stateDir>/task-board.json, written by the app (src/main/lib/task-board.ts),
 * only read here. IMPLEMENTATION_PLAN.md is never reordered, so the user's repository stays clean.
 * { version: 1, revision, order: PlanItemKey[], groupByPhase, updatedAt }
 */
export const TASK_BOARD_FILE = "task-board.json";
/** At most this many open items are listed for Assessment; the rest follow in the same order. */
export const PRIORITY_LIST_MAX = 40;

export const normalizeTitle = (title) => String(title ?? "").replace(/\s+/g, " ").trim().toLowerCase();

/** An item's key: phase number, normalized title and which duplicate of that title in the phase it is.
 *  The checkbox is not part of it, so checking an item off keeps its key. Mirrored in src/main/lib/task-board.ts. */
export const planItemKey = (phase, title, ordinal = 0) => createHash("sha1").update(`${phase}\n${normalizeTitle(title)}\n${ordinal}`).digest("hex").slice(0, 12);

/** Every plan item with its key, in document order. ambiguous: its title appears on more than one plan line,
 *  so the engine cannot check it off by its text. */
export function keyPlanItems(plan) {
  const items = [], seen = new Map(), counts = new Map();
  for (const phase of plan?.phases ?? []) for (const task of phase.tasks ?? []) {
    const norm = normalizeTitle(task.title);
    const local = `${phase.number}\n${norm}`;
    const ordinal = seen.get(local) ?? 0;
    seen.set(local, ordinal + 1);
    counts.set(norm, (counts.get(norm) ?? 0) + 1);
    items.push({ id: planItemKey(phase.number, task.title, ordinal), phase: { number: phase.number, title: phase.title }, title: task.title, depth: task.depth ?? 0, completed: Boolean(task.completed), ordinal });
  }
  for (const item of items) item.ambiguous = counts.get(normalizeTitle(item.title)) > 1;
  return items;
}

/**
 * The open items in priority order. Keys that match no open item are dropped, the rest keep their place, and an
 * open item the order does not know yet goes right after the open item before it in the plan (at the top when
 * there is none), so with no saved order this is plan order.
 */
export function resolvePriority(items, order = []) {
  const open = items.filter((item) => !item.completed);
  const byId = new Map(open.map((item) => [item.id, item]));
  const result = [];
  for (const id of order) if (byId.has(id) && !result.includes(byId.get(id))) result.push(byId.get(id));
  open.forEach((item, index) => {
    if (result.includes(item)) return;
    const before = index > 0 ? result.indexOf(open[index - 1]) : -1;
    result.splice(before + 1, 0, item);
  });
  return result;
}

export async function readTaskBoardState(stateDir) {
  const fallback = { version: 1, revision: 0, order: [], groupByPhase: true, updatedAt: null };
  try {
    const value = JSON.parse(await readFile(path.join(stateDir, TASK_BOARD_FILE), "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
    return {
      version: 1,
      revision: Number.isInteger(value.revision) ? value.revision : 0,
      order: Array.isArray(value.order) ? value.order.filter((key) => typeof key === "string") : [],
      groupByPhase: value.groupByPhase !== false,
      updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null,
    };
  } catch { return fallback; }
}

/** The Assessment prompt section: the binding selection rule and the ordered open items. Empty when nothing is open. */
export function priorityText(ordered, { deferred = [] } = {}) {
  if (!ordered.length) return "";
  const deferredTitles = new Set(deferred.flatMap((d) => (Array.isArray(d.planItems) ? d.planItems : [])).map(normalizeTitle));
  const lines = ordered.slice(0, PRIORITY_LIST_MAX).map((item, i) => {
    const notes = [`phase ${item.phase.number}`, deferredTitles.has(normalizeTitle(item.title)) ? "deferred" : null, item.ambiguous ? "title appears more than once in the plan" : null].filter(Boolean);
    return `${i + 1}. [${item.id}] ${item.title} (${notes.join("; ")})`;
  });
  if (ordered.length > PRIORITY_LIST_MAX) lines.push(`... and ${ordered.length - PRIORITY_LIST_MAX} more open items after these, in this order.`);
  return [
    "Task priority (the user's order on the Task board, highest first; it replaces plan order):",
    "Choose the highest-priority eligible item in this list. Pass over an item only when it is deferred, already running in parallel this round, shares a file or folder with a task already running this round, depends on an unfinished item, or cannot be done within the task-size and safety limits; then take the next eligible item. Several related items may make up one task only as the task size allows, starting with the highest eligible one. In planItems put each chosen item's text exactly as written between its bracketed id and the parenthesised note, without the number, id or note; put the ids (the bracketed keys) in planItemIds.",
    ...lines,
  ].join("\n");
}

/** The Task priority section for the plan and order on disk now; "" when the plan has no open item or cannot be read.
 *  A parallel round reads it once at its start, so every task of the round is chosen against the same order. */
export async function taskPrioritySection({ workspace, stateDir }) {
  try {
    const items = keyPlanItems(await readImplementationProgress(workspace));
    const state = await readTaskBoardState(stateDir);
    return priorityText(resolvePriority(items, state.order), { deferred: await readDeferred(stateDir).catch(() => []) });
  } catch { return ""; }
}

/** The objective with the Task priority section appended (unchanged when there is none). */
export async function objectiveWithPriority({ workspace, stateDir, objective }) {
  const text = await taskPrioritySection({ workspace, stateDir });
  return text ? `${objective}\n\n${text}` : objective;
}
