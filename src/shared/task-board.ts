import type { PlanItemKey, TaskBoard, TaskBoardActivity, TaskBoardItem } from "./types";

/**
 * The Task board's pure parts, shared by main (building the board) and the renderer (reordering).
 * Priority is one global order of open items; the phase grouping is a filtered view of it, so a move
 * inside a phase only swaps that phase's places in the order and a move in the flat list is global.
 * The engine resolves the same order the same way (engine/src/task-priority.mjs).
 */

export interface KeyedPlanItem {
  id: PlanItemKey;
  phase: { number: number; title: string };
  title: string;
  depth: number;
  completed: boolean;
  ordinal: number;
  ambiguous: boolean;
}

/** A task as the board needs it: which plan items it works on. */
export interface BoardTask {
  id: string;
  name?: string;
  planItems?: string[];
  planItemIds?: string[];
}

export interface BoardInputs {
  items: KeyedPlanItem[];
  order: PlanItemKey[];
  revision: number;
  groupByPhase: boolean;
  /** The engine's own task (not a parallel round's placeholder). */
  current?: BoardTask | null;
  /** Tasks of the parallel round running now, with their lane folder. */
  parallel?: (BoardTask & { lane: string })[];
  deferred?: { id: string; name?: string; reason?: string; planItems?: string[] }[];
}

export const normalizeTitle = (title: string) => String(title ?? "").replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Open items in priority order: keys that match no open item drop, the rest keep their place, and an open item
 * the order does not know yet goes right after the open item before it in the plan (first when there is none).
 */
export function resolvePriority<T extends { id: string; completed: boolean }>(items: T[], order: PlanItemKey[]): T[] {
  const open = items.filter((i) => !i.completed);
  const byId = new Map(open.map((i) => [i.id, i]));
  const result: T[] = [];
  for (const id of order) {
    const item = byId.get(id);
    if (item && !result.includes(item)) result.push(item);
  }
  open.forEach((item, index) => {
    if (result.includes(item)) return;
    const before = index > 0 ? result.indexOf(open[index - 1]) : -1;
    result.splice(before + 1, 0, item);
  });
  return result;
}

/** The items a task works on: by key when it names any, otherwise by exact (normalized) title. */
export function itemsOfTask(items: KeyedPlanItem[], task: { planItems?: string[]; planItemIds?: string[] }): KeyedPlanItem[] {
  const ids = new Set(task.planItemIds ?? []);
  const byId = items.filter((i) => ids.has(i.id));
  if (byId.length) return byId;
  const titles = new Set((task.planItems ?? []).map(normalizeTitle));
  return items.filter((i) => titles.has(normalizeTitle(i.title)));
}

/**
 * The three columns. Finished: checked in the plan. In progress: an open item the current task, a running
 * parallel task works on. Planned: every other open item (deferred ones keep a badge).
 */
export function deriveBoard(input: BoardInputs): TaskBoard {
  const { items } = input;
  const activity = new Map<string, TaskBoardActivity[]>();
  const add = (list: KeyedPlanItem[], entry: TaskBoardActivity) => {
    for (const item of list) {
      const known = activity.get(item.id) ?? [];
      if (!known.some((a) => a.kind === entry.kind && a.taskId === entry.taskId)) activity.set(item.id, [...known, entry]);
    }
  };
  const working = new Set<string>();
  const work = (list: KeyedPlanItem[], entry: TaskBoardActivity) => {
    const open = list.filter((i) => !i.completed);
    open.forEach((i) => working.add(i.id));
    add(open, entry);
  };
  if (input.current) work(itemsOfTask(items, input.current), { kind: "current", taskId: input.current.id, name: input.current.name ?? input.current.id });
  for (const t of input.parallel ?? []) work(itemsOfTask(items, t), { kind: "parallel", taskId: t.id, name: t.name ?? t.id, detail: t.lane });
  for (const d of input.deferred ?? []) {
    if (!d.planItems?.length) continue;
    add(itemsOfTask(items, { planItems: d.planItems }).filter((i) => !i.completed), { kind: "deferred", taskId: d.id, name: d.name ?? d.id, ...(d.reason ? { detail: d.reason } : {}) });
  }
  const toItem = (i: KeyedPlanItem, priority: number | null): TaskBoardItem => ({
    id: i.id,
    phase: i.phase,
    title: i.title,
    depth: i.depth,
    column: i.completed ? "finished" : working.has(i.id) ? "in-progress" : "planned",
    priority,
    ambiguous: i.ambiguous,
    activity: activity.get(i.id) ?? [],
  });
  const open = resolvePriority(items, input.order).map((i, n) => toItem(i, n));
  const finished = items.filter((i) => i.completed).map((i) => toItem(i, null));
  return { revision: input.revision, groupByPhase: input.groupByPhase, items: [...open, ...finished] };
}

/** Board items of one column, in board order (priority for open items, plan order for finished ones). */
export const columnItems = (board: TaskBoard, column: TaskBoardItem["column"]) => board.items.filter((i) => i.column === column);

/** The full priority order of open items, as the board shows it. */
export const boardOrder = (board: TaskBoard): PlanItemKey[] => board.items.filter((i) => i.priority !== null).map((i) => i.id);

/**
 * Moves view[from] to position `to` of a view (a filtered list of the order, such as one phase's Planned items)
 * and returns the new global order: the view's items are put back into the places they held, so every item
 * outside the view keeps its place.
 */
export function reorderWithin(order: PlanItemKey[], view: PlanItemKey[], from: number, to: number): PlanItemKey[] {
  if (from < 0 || from >= view.length) return order;
  const target = Math.max(0, Math.min(view.length - 1, to));
  if (target === from) return order;
  const moved = [...view];
  const [id] = moved.splice(from, 1);
  moved.splice(target, 0, id);
  const inView = new Set(view);
  let next = 0;
  return order.map((key) => (inView.has(key) ? moved[next++] : key));
}

/** The Planned items a view shows: all of them (flat), or one phase's. */
export function plannedView(board: TaskBoard, phase: number | null): PlanItemKey[] {
  return columnItems(board, "planned").filter((i) => phase === null || i.phase.number === phase).map((i) => i.id);
}

/** The board with its open items put in `order` (an optimistic view of a reorder that is being saved). */
export function withOrder(board: TaskBoard, order: PlanItemKey[]): TaskBoard {
  const open = resolvePriority(board.items.filter((i) => i.priority !== null).map((item) => ({ id: item.id, completed: false, item })), order);
  return { ...board, items: [...open.map(({ item }, n) => ({ ...item, priority: n })), ...board.items.filter((i) => i.priority === null)] };
}
