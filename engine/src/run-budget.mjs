import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { atomicWriteJson } from "./dashboard-state.mjs";
import { flushActionLog, verifyActionLog } from "./action-log.mjs";

// Unattended mode: run-wide limits the engine enforces itself. A limit asks for Stop, so the loop ends at
// its next safe point (never mid-task), and the end-of-run report says which limit ended it.
export const RUN = {
  unattended: false, maxTasks: 0, maxHours: 0, maxElevations: 0, maxTokens: 0, maxCost: 0, maxTokensDay: 0, maxCostDay: 0,
  startedAt: Date.now(), tasksPassed: 0, failures: 0, corrections: 0, elevations: 0, attention: 0, limit: null,
  usage: { input: 0, cached: 0, output: 0, costUsd: 0, calls: 0 }, day: { date: null, tokens: 0, costUsd: 0 },
};
const NO_LIMITS = { unattended: false, maxTasks: 0, maxHours: 0, maxElevations: 0, maxTokens: 0, maxCost: 0, maxTokensDay: 0, maxCostDay: 0 };
let watched = null; // { state, stateDir } once the run is watched for its token and spend budget
let dayWrite = Promise.resolve();

function count(value, flag, { decimal = false } = {}) {
  if (value === undefined) return 0;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || (!decimal && !Number.isInteger(parsed))) throw new Error(`--${flag} must be a ${decimal ? "number" : "whole number"} of at least 0`);
  return parsed;
}

/** --unattended true|false, --max-tasks N, --max-hours H, --max-elevations N, --max-tokens N, --max-cost USD,
 *  --max-tokens-day N, --max-cost-day USD (0 = no limit). */
export function parseRunLimits(options) {
  const unattended = options.unattended === undefined ? false : options.unattended === "true" ? true : options.unattended === "false" ? false : (() => { throw new Error("--unattended must be true or false"); })();
  const limits = { unattended, maxTasks: count(options["max-tasks"], "max-tasks"), maxHours: count(options["max-hours"], "max-hours", { decimal: true }), maxElevations: count(options["max-elevations"], "max-elevations") };
  // Budget flags appear only when given, so runs without them keep the limits they had before.
  for (const [key, flag, decimal] of [["maxTokens", "max-tokens"], ["maxCost", "max-cost", true], ["maxTokensDay", "max-tokens-day"], ["maxCostDay", "max-cost-day", true]])
    if (options[flag] !== undefined) limits[key] = count(options[flag], flag, { decimal });
  return limits;
}

export function useRunLimits(limits = {}) {
  Object.assign(RUN, { ...NO_LIMITS, ...limits, startedAt: Date.now(), tasksPassed: 0, failures: 0, corrections: 0, elevations: 0, attention: 0, limit: null,
    usage: { input: 0, cached: 0, output: 0, costUsd: 0, calls: 0 }, day: { date: null, tokens: 0, costUsd: 0 } });
  watched = null;
}

const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const runTokens = () => RUN.usage.input + RUN.usage.output;
const money = (usd) => `$${usd.toFixed(2)}`;
const n = (value) => value.toLocaleString("en-US");

/** Watches this run's token and spend use; the day's totals carry over between runs in <state>/usage-day.json. */
export async function watchUsage(state, stateDir) {
  watched = { state, stateDir };
  let saved = null;
  try { saved = JSON.parse(await readFile(path.join(stateDir, "usage-day.json"), "utf8")); } catch { /* first run today */ }
  RUN.day = saved?.date === today() ? { date: saved.date, tokens: Number(saved.tokens) || 0, costUsd: Number(saved.costUsd) || 0 } : { date: today(), tokens: 0, costUsd: 0 };
}

/** One CLI call's usage: input tokens (cached ones included), output tokens, and cost when the CLI reports it.
 *  A budget asks for Stop like the other limits, so the work that crosses it still finishes. */
export async function recordUsage({ input = 0, cached = 0, output = 0, costUsd = 0 } = {}) {
  const clean = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0);
  input = clean(input); cached = clean(cached); output = clean(output); costUsd = clean(costUsd);
  if (!input && !output && !costUsd) return;
  Object.assign(RUN.usage, { input: RUN.usage.input + input, cached: RUN.usage.cached + cached, output: RUN.usage.output + output, costUsd: RUN.usage.costUsd + costUsd, calls: RUN.usage.calls + 1 });
  if (RUN.day.date !== today()) RUN.day = { date: today(), tokens: 0, costUsd: 0 };
  RUN.day.tokens += input + output; RUN.day.costUsd += costUsd;
  if (!watched) return;
  const { state, stateDir } = watched, day = { ...RUN.day };
  dayWrite = dayWrite.then(() => atomicWriteJson(path.join(stateDir, "usage-day.json"), day)).catch(() => {});
  await dayWrite;
  if (RUN.maxTokens && runTokens() >= RUN.maxTokens) await reachLimit(state, "tokens", `Token budget reached: ${n(runTokens())} of ${n(RUN.maxTokens)} tokens this run.`);
  else if (RUN.maxCost && RUN.usage.costUsd >= RUN.maxCost) await reachLimit(state, "cost", `Spend budget reached: ${money(RUN.usage.costUsd)} of ${money(RUN.maxCost)} this run.`);
  else if (RUN.maxTokensDay && RUN.day.tokens >= RUN.maxTokensDay) await reachLimit(state, "tokens-day", `Daily token budget reached: ${n(RUN.day.tokens)} of ${n(RUN.maxTokensDay)} tokens today.`);
  else if (RUN.maxCostDay && RUN.day.costUsd >= RUN.maxCostDay) await reachLimit(state, "cost-day", `Daily spend budget reached: ${money(RUN.day.costUsd)} of ${money(RUN.maxCostDay)} today.`);
}

/** Records usage without ever failing the worker that reports it. */
export function noteUsage(usage) {
  if (usage) recordUsage(usage).catch(() => {});
}

/** claude -p --output-format json: the result envelope's usage and total_cost_usd. */
export function claudeUsage(stdout) {
  let envelope;
  try { envelope = JSON.parse(String(stdout).trim().split(/\r?\n/).filter(Boolean).at(-1)); } catch { return null; }
  const u = envelope?.usage;
  if (!u && envelope?.total_cost_usd === undefined) return null;
  const cached = (Number(u?.cache_read_input_tokens) || 0) + (Number(u?.cache_creation_input_tokens) || 0);
  return { input: (Number(u?.input_tokens) || 0) + cached, cached, output: Number(u?.output_tokens) || 0, costUsd: Number(envelope.total_cost_usd) || 0 };
}

/** codex exec --json: usage on each turn.completed event (input_tokens already includes cached_input_tokens; no cost). */
export function codexUsage(output) {
  const total = { input: 0, cached: 0, output: 0, costUsd: 0 };
  let found = false;
  for (const line of String(output ?? "").split(/\r?\n/)) {
    if (!line.includes("turn.completed")) continue;
    let event; try { event = JSON.parse(line); } catch { continue; }
    if (event?.type !== "turn.completed" || !event.usage) continue;
    found = true;
    total.input += Number(event.usage.input_tokens) || 0; total.cached += Number(event.usage.cached_input_tokens) || 0;
    total.output += (Number(event.usage.output_tokens) || 0) + (Number(event.usage.reasoning_output_tokens) || 0);
  }
  return found ? total : null;
}

/** opencode run --format json: tokens and cost on each step_finish event. */
export function openCodeUsage(events) {
  const total = { input: 0, cached: 0, output: 0, costUsd: 0 };
  let found = false;
  for (const event of events ?? []) {
    if (event?.type !== "step_finish") continue;
    const t = event.part?.tokens ?? {}, cached = (Number(t.cache?.read) || 0) + (Number(t.cache?.write) || 0);
    found = true;
    total.input += (Number(t.input) || 0) + cached; total.cached += cached;
    total.output += (Number(t.output) || 0) + (Number(t.reasoning) || 0); total.costUsd += Number(event.part?.cost) || 0;
  }
  return found ? total : null;
}

/** Automatic Elevation stays available until the run's Elevation limit is used. */
export function elevationAllowed() {
  return !RUN.maxElevations || RUN.elevations < RUN.maxElevations;
}

async function reachLimit(state, limit, detail) {
  if (RUN.limit) return;
  RUN.limit = { limit, detail, at: new Date().toISOString() };
  await state.setControl("stop", { source: "run-limit" });
  await state.record({ type: "run-limit", limit, message: detail });
}

/** Counts the run's outcomes from loop events and stops the run once a limit is reached. */
export async function trackRunEvent(state, event) {
  if (event.type === "qa-pass") RUN.tasksPassed++;
  else if (event.type === "qa-fail") RUN.failures++;
  else if (event.type === "retry") RUN.corrections++;
  else if (event.type === "sol-reassessment-started") RUN.elevations++;
  else if (event.type === "user-attention" || event.type === "blocked") RUN.attention++;
  if (event.type === "qa-pass" && RUN.maxTasks && RUN.tasksPassed >= RUN.maxTasks) await reachLimit(state, "tasks", `Task limit reached: ${RUN.tasksPassed} approved task(s).`);
}

/** Asks for Stop when the run's time limit passes; the current task still finishes. */
export function startDeadline(state) {
  if (!RUN.maxHours) return null;
  const timer = setTimeout(() => void reachLimit(state, "hours", `Time limit reached: ${RUN.maxHours} hour(s).`), RUN.maxHours * 3_600_000);
  timer.unref();
  return timer;
}

/** run-report.json and run-report.md in the state folder: how the run went and why it ended. */
export async function writeRunReport(stateDir, result) {
  const ended = new Date();
  const report = {
    unattended: RUN.unattended, startedAt: new Date(RUN.startedAt).toISOString(), endedAt: ended.toISOString(),
    hours: Math.round(((ended.getTime() - RUN.startedAt) / 3_600_000) * 100) / 100,
    status: result.status, reason: RUN.limit?.detail ?? result.output ?? null, limit: RUN.limit?.limit ?? null,
    tasksApproved: RUN.tasksPassed, qaFailures: RUN.failures, corrections: RUN.corrections, elevations: RUN.elevations, needsAttention: RUN.attention,
    usage: { tokens: runTokens(), input: RUN.usage.input, cached: RUN.usage.cached, output: RUN.usage.output, costUsd: Math.round(RUN.usage.costUsd * 10000) / 10000, calls: RUN.usage.calls },
    limits: { maxTasks: RUN.maxTasks, maxHours: RUN.maxHours, maxElevations: RUN.maxElevations, maxTokens: RUN.maxTokens, maxCost: RUN.maxCost, maxTokensDay: RUN.maxTokensDay, maxCostDay: RUN.maxCostDay },
    // The chain head at the end of the run: a log later cut short no longer reaches this entry.
    actionLog: await flushActionLog().then(() => verifyActionLog(stateDir)).catch((error) => ({ ok: false, reason: error.message })),
  };
  await atomicWriteJson(path.join(stateDir, "run-report.json"), report);
  const line = (label, value) => `- ${label}: ${value}`;
  await writeFile(path.join(stateDir, "run-report.md"), [
    `# Run report`, "",
    line("Mode", report.unattended ? "Unattended" : "Attended"), line("Started", report.startedAt), line("Ended", `${report.endedAt} (${report.hours} h)`),
    line("Result", report.status), line("Why it ended", String(report.reason ?? "").split(/\r?\n/)[0].slice(0, 300) || "finished"), "",
    line("Tasks approved", report.tasksApproved), line("QA failures", report.qaFailures), line("Corrections", report.corrections), line("Elevations", report.elevations), line("Stops for attention", report.needsAttention), "",
    line("Tokens", `${n(report.usage.tokens)} (input ${n(report.usage.input)}, of which cached ${n(report.usage.cached)}; output ${n(report.usage.output)}) over ${report.usage.calls} call(s)`),
    line("Reported spend", `${money(report.usage.costUsd)} (only CLIs that report cost count: Claude Code, OpenCode)`), "",
    line("Action log", report.actionLog.ok ? `verified, ${report.actionLog.entries} entries, head ${report.actionLog.head}` : `NOT VERIFIED (entry ${report.actionLog.brokenAt ?? "?"}: ${report.actionLog.reason})`),
    line("Limits", `tasks ${report.limits.maxTasks || "none"}, hours ${report.limits.maxHours || "none"}, Elevations ${report.limits.maxElevations || "none"}, tokens ${report.limits.maxTokens ? n(report.limits.maxTokens) : "none"}, spend ${report.limits.maxCost ? money(report.limits.maxCost) : "none"}, tokens/day ${report.limits.maxTokensDay ? n(report.limits.maxTokensDay) : "none"}, spend/day ${report.limits.maxCostDay ? money(report.limits.maxCostDay) : "none"}`), "",
  ].join("\n"));
  return report;
}
