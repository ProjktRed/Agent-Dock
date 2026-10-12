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

/** --elevation-after, --resolver-max-strategies, --max-corrections, --task-max-files, --task-max-new-lines, --task-max-read-files. */
export function parseTuning(options) {
  const tuning = { ...DEFAULT_TUNING };
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
}

/** The sizing sentence in the Assessment prompt, from the current task-size limits. */
export function taskSizingText(t = TUNING) {
  const files = t.taskMaxFiles === 1 ? "one file per task where possible" : `at most ${t.taskMaxFiles} files per task`;
  return `${files}, splitting implementation and tests into sequential tasks, each new file under about ${t.taskMaxNewLines} lines`;
}
