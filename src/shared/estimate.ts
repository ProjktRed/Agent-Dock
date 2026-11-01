import type { RunReport, TaskMode } from "./types";

// Plan estimates before Start, from the project's own runs. Recent runs count more (half-life in runs),
// a range shows how much the pace varies, and calibration corrects a steady bias: the app records each
// estimate when a run starts (estimates.json in the state folder) and compares it with what that run
// actually took per plan item.

export interface PlanEstimate {
  tasks: number; hours: number; tokens: number; costUsd: number; basisTasks: number;
  /** The middle half of the pace of single runs (25th to 75th percentile), with at least 3 runs. */
  range?: { hours: [number, number]; tokens: [number, number] };
  /** Applied correction (actual ÷ estimated, the median of recent runs), with at least 3 compared runs. */
  calibration?: { hours: number; tokens: number; runs: number };
}

/** What a start expected per plan item, kept so later estimates can learn from the miss. */
export interface EstimateRecord { at: string; mode: TaskMode; perItem: { hours: number; tokens: number; costUsd: number } }

export interface EstimateOptions { recent?: number; halfLife?: number; records?: EstimateRecord[] }

export const ESTIMATES_FILE = "estimates.json";
export const ESTIMATES_KEPT = 50;
const HALF_LIFE = 5;
const CALIBRATION_MIN = 3;
const CALIBRATION_RUNS = 10;
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

function quantile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * Pace per unit (approved task or plan item) over runs, newest first: weighted sums, so a run counts by
 * its size and its age (weight halves every halfLife runs).
 */
function pace(basis: RunReport[], units: (r: RunReport) => number, halfLife: number) {
  const w = (i: number) => (Number.isFinite(halfLife) ? 0.5 ** (i / halfLife) : 1);
  const total = basis.reduce((sum, r, i) => sum + w(i) * units(r), 0);
  const per = (pick: (r: RunReport) => number) => basis.reduce((sum, r, i) => sum + w(i) * (pick(r) || 0), 0) / total;
  return { hours: per((r) => r.hours), tokens: per((r) => r.usage?.tokens ?? 0), costUsd: per((r) => r.usage?.costUsd ?? 0) };
}

function range(basis: RunReport[], units: (r: RunReport) => number, remaining: number): PlanEstimate["range"] {
  if (basis.length < 3) return undefined;
  const hours = basis.map((r) => r.hours / units(r)), tokens = basis.map((r) => (r.usage?.tokens ?? 0) / units(r));
  return { hours: [quantile(hours, 0.25) * remaining, quantile(hours, 0.75) * remaining], tokens: [quantile(tokens, 0.25) * remaining, quantile(tokens, 0.75) * remaining] };
}

/**
 * The correction for one task size: each recorded estimate is matched with the run that started with it
 * (its report starts within ten minutes after the record) and that checked off plan items; the median of
 * actual ÷ estimated over the last runs, kept between 0.5 and 2 so one odd run cannot swing it.
 */
export function calibration(records: EstimateRecord[], runs: RunReport[], mode: TaskMode): PlanEstimate["calibration"] {
  const ratios: { hours: number; tokens: number }[] = [];
  for (const record of [...records].filter((r) => r.mode === mode).sort((a, b) => Date.parse(b.at) - Date.parse(a.at))) {
    const at = Date.parse(record.at);
    const run = runs.find((r) => (r.planItems ?? 0) > 0 && Date.parse(r.startedAt) >= at - 60_000 && Date.parse(r.startedAt) <= at + 10 * 60_000);
    if (!run || !(record.perItem.hours > 0)) continue;
    const items = run.planItems!;
    ratios.push({ hours: run.hours / items / record.perItem.hours, tokens: record.perItem.tokens > 0 ? (run.usage?.tokens ?? 0) / items / record.perItem.tokens : 1 });
    if (ratios.length >= CALIBRATION_RUNS) break;
  }
  if (ratios.length < CALIBRATION_MIN) return undefined;
  return { hours: clamp(quantile(ratios.map((r) => r.hours), 0.5), 0.5, 2), tokens: clamp(quantile(ratios.map((r) => r.tokens), 0.5), 0.5, 2), runs: ratios.length };
}

function scaled(remaining: number, per: ReturnType<typeof pace>, basisTasks: number, spread: PlanEstimate["range"], fix: PlanEstimate["calibration"]): PlanEstimate {
  const h = fix?.hours ?? 1, t = fix?.tokens ?? 1;
  return {
    tasks: remaining, hours: per.hours * remaining * h, tokens: per.tokens * remaining * t, costUsd: per.costUsd * remaining * t, basisTasks,
    ...(spread ? { range: { hours: [spread.hours[0] * h, spread.hours[1] * h] as [number, number], tokens: [spread.tokens[0] * t, spread.tokens[1] * t] as [number, number] } } : {}),
    ...(fix ? { calibration: fix } : {}),
  };
}

/**
 * Plan estimate before Start: the plan's remaining items at this project's own pace, from the recent
 * runs that approved tasks (hours, counted tokens and spend per approved task). One plan item is
 * counted as one task, so it is a rough guide. Null without history to go on.
 */
export function planEstimate(remaining: number, runs: RunReport[], { recent = 20, halfLife = HALF_LIFE }: EstimateOptions = {}): PlanEstimate | null {
  if (!(remaining > 0)) return null;
  const basis = runs.slice(0, recent).filter((r) => r.tasksApproved > 0);
  const tasks = basis.reduce((sum, r) => sum + r.tasksApproved, 0);
  if (!tasks) return null;
  const units = (r: RunReport) => r.tasksApproved;
  return scaled(remaining, pace(basis, units, halfLife), tasks, range(basis, units, remaining), undefined);
}

/** The pace per plan item for one task size (0.35 on: runs that checked off plan items), or null. */
export function itemPace(runs: RunReport[], mode: TaskMode, { recent = 40, halfLife = HALF_LIFE }: EstimateOptions = {}) {
  const basis = runs.slice(0, recent).filter((r) => (r.taskMode ?? "eco") === mode && (r.planItems ?? 0) > 0);
  return basis.length ? { basis, per: pace(basis, (r) => r.planItems ?? 0, halfLife) } : null;
}

/**
 * The same estimate per task size, from runs in each mode that checked off plan items (0.35 on):
 * hours, tokens and spend per finished plan item, corrected by that size's calibration. Runs from
 * before 0.35 have no item count and are left out.
 */
export function modeEstimates(remaining: number, runs: RunReport[], options: EstimateOptions = {}): Partial<Record<TaskMode, PlanEstimate>> {
  const out: Partial<Record<TaskMode, PlanEstimate>> = {};
  if (!(remaining > 0)) return out;
  for (const mode of ["eco", "standard", "max"] as const) {
    const found = itemPace(runs, mode, options);
    if (!found) continue;
    const units = (r: RunReport) => r.planItems ?? 0;
    out[mode] = scaled(remaining, found.per, found.basis.reduce((sum, r) => sum + r.tasksApproved, 0), range(found.basis, units, remaining), calibration(options.records ?? [], runs, mode));
  }
  return out;
}

/** The record a start appends to estimates.json: the uncorrected pace, so calibration compares like with like. */
export function estimateRecord(runs: RunReport[], mode: TaskMode, now = new Date()): EstimateRecord | null {
  const found = itemPace(runs, mode);
  return found ? { at: now.toISOString(), mode, perItem: found.per } : null;
}
