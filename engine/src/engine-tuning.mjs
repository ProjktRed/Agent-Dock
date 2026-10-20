// Loop limits that were fixed in the engine. Defaults reproduce the original behaviour exactly;
// the app passes other values only when its engine guardrails are off.

export const DEFAULT_TUNING = Object.freeze({
  /** Automatic Elevation after this many attempted Assessment corrections. */
  elevationAfter: 3,
  /** Distinct Resolver recovery strategies applied per task before human review. */
  resolverMaxStrategies: 3,
  /** Assessment corrections before the loop stops for user attention; 0 = no limit. */
  maxCorrections: 0,
  /** Task sizing Assessment writes for the implementation worker. */
  taskMaxFiles: 1,
  taskMaxNewLines: 200,
  taskMaxReadFiles: 3,
  /** Task size mode: eco splits plan items into small tasks, standard does one plan item per task, max has no fixed size. */
  taskMode: "eco",
  /** In standard or max mode, a task that fails review twice is set aside and redone one size smaller. */
  stepDown: true,
});

export const TASK_MODES = ["eco", "standard", "max"];
/** Each mode's sizing. In max mode 0 = no limit; the owner may set limits with the --task-max-* flags. */
export const MODE_SIZING = Object.freeze({
  eco: {},
  standard: Object.freeze({ taskMaxFiles: 10, taskMaxNewLines: 800, taskMaxReadFiles: 10 }),
  max: Object.freeze({ taskMaxFiles: 0, taskMaxNewLines: 0, taskMaxReadFiles: 0 }),
});

// Live binding read by the workers and the loop (like the role models in codex-worker.mjs).
export const TUNING = { ...DEFAULT_TUNING };

const FLAGS = {
  elevationAfter: ["elevation-after", 1],
  resolverMaxStrategies: ["resolver-max-strategies", 1],
  maxCorrections: ["max-corrections", 0],
  taskMaxFiles: ["task-max-files", 1],
  taskMaxNewLines: ["task-max-new-lines", 10],
  taskMaxReadFiles: ["task-max-read-files", 1],
};

/** --task-mode eco|standard|max, then --elevation-after, --resolver-max-strategies, --max-corrections, --task-max-files,
 *  --task-max-new-lines, --task-max-read-files (explicit sizing flags override the mode's sizing). */
export function parseTuning(options) {
  const mode = options["task-mode"] ?? "eco";
  if (!TASK_MODES.includes(mode)) throw new Error("--task-mode must be eco, standard or max");
  const tuning = { ...DEFAULT_TUNING, ...MODE_SIZING[mode], taskMode: mode };
  if (options["step-down"] !== undefined) {
    if (!["true", "false"].includes(options["step-down"])) throw new Error("--step-down must be true or false");
    tuning.stepDown = options["step-down"] === "true";
  }
  for (const [key, [flag, min]] of Object.entries(FLAGS)) {
    const value = options[flag];
    if (value === undefined) continue;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < min) throw new Error(`--${flag} must be an integer of at least ${min}`);
    tuning[key] = parsed;
  }
  return tuning;
}

export function useTuning(values = {}) {
  Object.assign(TUNING, DEFAULT_TUNING, values);
  STEP_DOWN.active = null;
}

const SIZING_KEYS = ["taskMode", "taskMaxFiles", "taskMaxNewLines", "taskMaxReadFiles"];
const ECO_SIZING = { taskMaxFiles: DEFAULT_TUNING.taskMaxFiles, taskMaxNewLines: DEFAULT_TUNING.taskMaxNewLines, taskMaxReadFiles: DEFAULT_TUNING.taskMaxReadFiles };
/** How many approved tasks a step-down lasts at most when its plan items are not all checked off sooner. */
export const STEP_DOWN_TASKS = 5;
/** The step-down in force this run: { from, to, taskId, taskName, items, left, configured }. */
export const STEP_DOWN = { active: null };

/** One size smaller for the redo of a task that failed review twice: max to standard, standard to eco. */
export function stepDown(task) {
  const from = TUNING.taskMode;
  const to = from === "max" ? "standard" : from === "standard" ? "eco" : null;
  if (!to) return null;
  const configured = STEP_DOWN.active?.configured ?? Object.fromEntries(SIZING_KEYS.map((key) => [key, TUNING[key]]));
  Object.assign(TUNING, to === "eco" ? ECO_SIZING : MODE_SIZING[to], { taskMode: to });
  STEP_DOWN.active = { from, to, taskId: task.id, taskName: task.name ?? task.id, items: [...(task.planItems ?? [])], left: STEP_DOWN_TASKS, configured };
  return { from, to };
}

/** After an approved task during a step-down: back to the configured size once the set-aside task's plan items are done. */
export function noteStepDownApproval(task) {
  const active = STEP_DOWN.active;
  if (!active) return null;
  const done = new Set(task.planItems ?? []);
  active.items = active.items.filter((item) => !done.has(item));
  active.left--;
  if (active.items.length && active.left > 0) return null;
  Object.assign(TUNING, active.configured);
  STEP_DOWN.active = null;
  return { mode: TUNING.taskMode, from: active.to };
}

/** The sizing sentence in the Assessment prompt, from the current task-size limits. */
export function taskSizingText(t = TUNING) {
  const limits = [t.taskMaxFiles > 0 && `at most ${t.taskMaxFiles} files per task`, t.taskMaxNewLines > 0 && `each new file under about ${t.taskMaxNewLines} lines`].filter(Boolean);
  if (t.taskMode === "standard") return ["one task per unchecked plan item, its code and tests together (only a part of one when the item is bigger than these limits)", ...limits].join(", ");
  if (t.taskMode === "max") return ["as much as the worker can finish and verify in one attempt: one or more unchecked plan items per task, code and tests together", ...limits].join(", ");
  const files = t.taskMaxFiles === 1 ? "one file per task where possible" : `at most ${t.taskMaxFiles} files per task`;
  return `${files}, splitting implementation and tests into sequential tasks, each new file under about ${t.taskMaxNewLines} lines`;
}

/** The Assessment instruction for how much one task covers. */
export function taskScopeText(t = TUNING) {
  if (t.taskMode === "standard") return "Choose exactly one bounded implementation task toward the user's objective: a whole unchecked plan item where it fits the sizing below. Do not implement or commit anything.";
  if (t.taskMode === "max") return "Choose exactly one bounded implementation task toward the user's objective: it may cover several unchecked plan items when they belong together. Do not implement or commit anything.";
  return "Choose exactly one small bounded implementation task toward the user's objective. Do not implement or commit anything.";
}

/** The worker description Assessment sizes tasks for. */
export function workerSizingText(t = TUNING) {
  if (t.taskMode === "standard") return "Worker sizing (standard mode: a capable model with a large context): " + taskSizingText(t);
  if (t.taskMode === "max") return "Worker sizing (max mode, chosen by the owner: a capable model with a large context): " + taskSizingText(t);
  return "Local worker sizing (98K context, but generation slows from about 48 to 17 tok/s as it fills, and it loses work exploring or patching large files): " + taskSizingText(t);
}

/** Which files the worker may read; max mode without a read limit names them without a count. */
export function readFilesText(t = TUNING) {
  return t.taskMaxReadFiles > 0
    ? "Name the only files to read (at most " + t.taskMaxReadFiles + ", with line ranges for large files)."
    : "Name the files to read (with line ranges for large files).";
}
