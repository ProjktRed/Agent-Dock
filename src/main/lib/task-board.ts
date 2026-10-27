import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import type { PlanProgress, TaskBoard, TaskBoardState, TaskBoardUpdate, TaskBoardWriteResult } from "@shared/types";
import { deriveBoard, normalizeTitle, resolvePriority, type BoardInputs, type BoardTask, type KeyedPlanItem } from "@shared/task-board";
import { readJson, writeJson } from "./json-file";
import { taskFileName } from "../projects";

/** <stateDir>/task-board.json. Only the app writes it; the engine reads it at each Assessment (engine/src/task-priority.mjs). */
export const TASK_BOARD_FILE = "task-board.json";

/** Same key as the engine's planItemKey: phase, normalized title and duplicate ordinal; never the checkbox. */
export const planItemKey = (phase: number, title: string, ordinal = 0) =>
  createHash("sha1").update(`${phase}\n${normalizeTitle(title)}\n${ordinal}`).digest("hex").slice(0, 12);

/** Every plan item with its key, in plan order (engine/src/task-priority.mjs keyPlanItems). */
export function keyPlanItems(plan: PlanProgress): KeyedPlanItem[] {
  const items: KeyedPlanItem[] = [];
  const seen = new Map<string, number>();
  const counts = new Map<string, number>();
  for (const phase of plan.phases) {
    for (const task of phase.tasks) {
      const norm = normalizeTitle(task.title);
      const local = `${phase.number}\n${norm}`;
      const ordinal = seen.get(local) ?? 0;
      seen.set(local, ordinal + 1);
      counts.set(norm, (counts.get(norm) ?? 0) + 1);
      items.push({ id: planItemKey(phase.number, task.title, ordinal), phase: { number: phase.number, title: phase.title }, title: task.title, depth: task.depth, completed: task.completed, ordinal, ambiguous: false });
    }
  }
  for (const item of items) item.ambiguous = (counts.get(normalizeTitle(item.title)) ?? 0) > 1;
  return items;
}

const EMPTY: TaskBoardState = { version: 1, revision: 0, order: [], groupByPhase: true, updatedAt: null };

export async function readTaskBoardState(stateDir: string): Promise<TaskBoardState> {
  const value = await readJson<Partial<TaskBoardState> | null>(path.join(stateDir, TASK_BOARD_FILE), null).catch(() => null);
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...EMPTY };
  return {
    version: 1,
    revision: Number.isInteger(value.revision) ? (value.revision as number) : 0,
    order: Array.isArray(value.order) ? value.order.filter((k): k is string => typeof k === "string") : [],
    groupByPhase: value.groupByPhase !== false,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null,
  };
}

/** What is being worked on, from the engine's state folder. */
export async function readBoardActivity(stateDir: string, live: { task?: BoardTask | null; stage?: string } | null, processAlive: boolean): Promise<Pick<BoardInputs, "current" | "parallel" | "deferred" | "rerunnable">> {
  const read = <T>(file: string) => readJson<T | null>(path.join(stateDir, file), null).catch(() => null);
  const [saved, deferredRaw, kept] = await Promise.all([
    read<BoardTask & { automation?: { recovery?: { phase?: string } | null } }>("current-task.json"),
    read<BoardInputs["deferred"]>("deferred-tasks.json"),
    readdir(path.join(stateDir, "tasks")).catch(() => [] as string[]),
  ]);
  const deferred = Array.isArray(deferredRaw) ? deferredRaw.filter((d) => d && typeof d.id === "string") : [];
  const setAside = new Set(deferred.map((d) => d.id));
  // The engine's task: the one live.json shows while it runs (a parallel round's placeholder names no items),
  // else a task it left unfinished (stopped, blocked, paused); an approved or set-aside task is not.
  let current: BoardTask | null = null;
  const liveTask = live?.task;
  if (processAlive && liveTask && !String(liveTask.id).startsWith("parallel-round-") && !["pass", "complete"].includes(live?.stage ?? "")) current = liveTask;
  else if (saved?.id && saved.automation?.recovery && saved.automation.recovery.phase !== "passed") current = saved;
  if (current && setAside.has(current.id)) current = null;
  // Each running task engine of a parallel round: parallel/<lane>/child.json with a pid and no end, while the run is alive.
  const parallel: NonNullable<BoardInputs["parallel"]> = [];
  if (processAlive) {
    const root = path.join(stateDir, "parallel");
    for (const lane of await readdir(root).catch(() => [] as string[])) {
      const child = await readJson<{ pid?: number; exitedAt?: string | null } | null>(path.join(root, lane, "child.json"), null).catch(() => null);
      if (!Number.isInteger(child?.pid) || child?.exitedAt) continue;
      const task = await readJson<BoardTask | null>(path.join(root, lane, "task.json"), null).catch(() => null);
      if (task?.id) parallel.push({ ...task, lane });
    }
  }
  // Kept task definitions (<state>/tasks/<id>.json, engine/src/task-archive.mjs).
  const keptNames = new Set(kept);
  const rerunnable = new Set(deferred.map((d) => d.id).filter((id) => keptNames.has(taskFileName(String(id)))));
  return {
    current,
    parallel,
    deferred,
    rerunnable,
  };
}

export async function buildTaskBoard(stateDir: string, plan: PlanProgress, live: { task?: BoardTask | null; stage?: string } | null, processAlive: boolean): Promise<TaskBoard> {
  const [state, activity] = await Promise.all([readTaskBoardState(stateDir), readBoardActivity(stateDir, live, processAlive)]);
  return deriveBoard({ items: keyPlanItems(plan), order: state.order, revision: state.revision, groupByPhase: state.groupByPhase, ...activity });
}

const locks = new Map<string, Promise<unknown>>();
/** One read-check-write at a time per state folder, so two quick drags never both pass the revision check. */
function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (locks.get(key) ?? Promise.resolve()).catch(() => {}).then(fn);
  locks.set(key, run);
  return run.finally(() => { if (locks.get(key) === run) locks.delete(key); });
}

/**
 * Applies a Task board change. An order change made on another revision than the one on disk is rejected
 * (the board the user dragged on is stale); the grouping toggle always applies. The order is saved reconciled
 * against the plan: open items only, each once, new ones in place.
 */
export function writeTaskBoard(stateDir: string, plan: PlanProgress, update: TaskBoardUpdate, { board = () => buildTaskBoard(stateDir, plan, null, false), now = () => new Date().toISOString() }: { board?: () => Promise<TaskBoard>; now?: () => string } = {}): Promise<TaskBoardWriteResult> {
  return serialized(stateDir, async () => {
    const state = await readTaskBoardState(stateDir);
    const reorders = update.reset === true || Array.isArray(update.order);
    if (reorders && update.expectedRevision !== state.revision) return { ok: false, reason: "stale", board: await board() } as const;
    const items = keyPlanItems(plan);
    const order = update.reset === true ? [] : Array.isArray(update.order) ? resolvePriority(items, update.order.filter((k) => typeof k === "string")).map((i) => i.id) : state.order;
    const next: TaskBoardState = {
      version: 1,
      revision: state.revision + 1,
      order,
      groupByPhase: typeof update.groupByPhase === "boolean" ? update.groupByPhase : state.groupByPhase,
      updatedAt: now(),
    };
    await writeJson(path.join(stateDir, TASK_BOARD_FILE), next);
    return { ok: true, board: await board() } as const;
  });
}

/** A Task board change as it arrives over IPC, reduced to the fields and types it may have. */
export function sanitizeTaskBoardUpdate(value: unknown): TaskBoardUpdate {
  const v = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  if (!Number.isInteger(v.expectedRevision) || (v.expectedRevision as number) < 0) throw new Error("Task board change needs the revision it was made on");
  const update: TaskBoardUpdate = { expectedRevision: v.expectedRevision as number };
  if (Array.isArray(v.order)) update.order = v.order.filter((k): k is string => typeof k === "string" && /^[0-9a-f]{12}$/.test(k)).slice(0, 10_000);
  if (v.reset === true) update.reset = true;
  if (typeof v.groupByPhase === "boolean") update.groupByPhase = v.groupByPhase;
  return update;
}
