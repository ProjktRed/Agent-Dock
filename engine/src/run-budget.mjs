import { readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { atomicWriteJson } from "./dashboard-state.mjs";
import { flushActionLog, verifyActionLog } from "./action-log.mjs";
import { redactText } from "./redact.mjs";
import { STEP_DOWN, TUNING } from "./engine-tuning.mjs";

// Unattended mode: run-wide limits the engine enforces itself. A limit asks for Stop, so the loop ends at
// its next safe point (never mid-task), and the end-of-run report says which limit ended it.
export const RUN = {
  unattended: false, limitRetryMinutes: null, maxTasks: 0, maxHours: 0, maxElevations: 0, maxTokens: 0, maxCost: 0, maxTokensDay: 0, maxCostDay: 0, prices: [],
  startedAt: Date.now(), tasksPassed: 0, planItems: 0, stepDowns: 0, failures: 0, corrections: 0, elevations: 0, attention: 0, limit: null, approved: [],
  usage: { input: 0, cached: 0, output: 0, costUsd: 0, estimatedUsd: 0, calls: 0 }, day: { date: null, tokens: 0, costUsd: 0 },
};
const NO_LIMITS = { unattended: false, limitRetryMinutes: null, maxTasks: 0, maxHours: 0, maxElevations: 0, maxTokens: 0, maxCost: 0, maxTokensDay: 0, maxCostDay: 0, prices: [] };
let watched = null; // { state, stateDir } once the run is watched for its token and spend budget
let dayWrite = Promise.resolve();

function count(value, flag, { decimal = false } = {}) {
  if (value === undefined) return 0;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || (!decimal && !Number.isInteger(parsed))) throw new Error(`--${flag} must be a ${decimal ? "number" : "whole number"} of at least 0`);
  return parsed;
}

/** --prices JSON: [{ model, input, cachedInput, output }] in USD per million tokens. A model ending in * matches by prefix.
 *  Prices apply only to calls whose CLI reports no cost (Codex), so spend budgets cover them too. */
export function parsePrices(value) {
  if (value === undefined || value === "") return [];
  let list;
  try { list = JSON.parse(value); } catch { throw new Error("--prices must be JSON"); }
  if (!Array.isArray(list)) throw new Error("--prices must be a JSON list");
  const price = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : 0);
  return list.filter((p) => p && typeof p.model === "string" && p.model.trim())
    .map((p) => ({ model: p.model.trim().toLowerCase(), input: price(p.input), cachedInput: price(p.cachedInput ?? p.input), output: price(p.output) }));
}

/** The price entry for a model: an exact match first, then the longest matching prefix (entries ending in *). */
export function priceFor(model, prices = RUN.prices) {
  const name = String(model ?? "").trim().toLowerCase();
  if (!name || !prices?.length) return null;
  const exact = prices.find((p) => p.model === name);
  if (exact) return exact;
  return prices.filter((p) => p.model.endsWith("*") && name.startsWith(p.model.slice(0, -1))).sort((a, b) => b.model.length - a.model.length)[0] ?? null;
}

/** Estimated USD for one call's tokens at the model's price, or 0 when the model has no price. */
export function estimateCost({ input = 0, cached = 0, output = 0 } = {}, model, prices = RUN.prices) {
  const p = priceFor(model, prices);
  if (!p) return 0;
  return (Math.max(0, input - cached) * p.input + cached * p.cachedInput + output * p.output) / 1_000_000;
}

/** --unattended true|false, --max-tasks N, --max-hours H, --max-elevations N, --max-tokens N, --max-cost USD,
 *  --max-tokens-day N, --max-cost-day USD (0 = no limit), --limit-retry-minutes N (0 = wait for Resume). */
export function parseRunLimits(options) {
  const unattended = options.unattended === undefined ? false : options.unattended === "true" ? true : options.unattended === "false" ? false : (() => { throw new Error("--unattended must be true or false"); })();
  const limits = { unattended, maxTasks: count(options["max-tasks"], "max-tasks"), maxHours: count(options["max-hours"], "max-hours", { decimal: true }), maxElevations: count(options["max-elevations"], "max-elevations") };
  // Budget flags appear only when given, so runs without them keep the limits they had before.
  if (options["limit-retry-minutes"] !== undefined) limits.limitRetryMinutes = count(options["limit-retry-minutes"], "limit-retry-minutes");
  for (const [key, flag, decimal] of [["maxTokens", "max-tokens"], ["maxCost", "max-cost", true], ["maxTokensDay", "max-tokens-day"], ["maxCostDay", "max-cost-day", true]])
    if (options[flag] !== undefined) limits[key] = count(options[flag], flag, { decimal });
  if (options.prices !== undefined) limits.prices = parsePrices(options.prices);
  return limits;
}

export function useRunLimits(limits = {}) {
  Object.assign(RUN, { ...NO_LIMITS, ...limits, startedAt: Date.now(), tasksPassed: 0, planItems: 0, stepDowns: 0, failures: 0, corrections: 0, elevations: 0, attention: 0, limit: null, approved: [],
    usage: { input: 0, cached: 0, output: 0, costUsd: 0, estimatedUsd: 0, calls: 0 }, day: { date: null, tokens: 0, costUsd: 0 } });
  watched = null;
}

/** How long a usage-limit wait lasts before the engine tries again by itself: 0 means only Resume continues.
 *  Unattended runs retry every 30 minutes by default, so an overnight run carries on once the limit resets. */
export const limitRetryMs = () => (RUN.limitRetryMinutes ?? (RUN.unattended ? 30 : 0)) * 60_000;

/** Waits out a usage limit: Stop ends the wait, Resume (a newer resume generation) continues, and with
 *  automatic retry the wait also ends once the interval since `since` has passed. */
export async function waitOutLimit({ readControl, generation, since = Date.now(), pollMs = 1000, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const retry = limitRetryMs();
  for (;;) {
    const control = await readControl();
    if (control.stopAfterSafePoint) return "stopped";
    if (Number(control.resumeGeneration ?? 0) > generation) return "resumed";
    if (retry && now() - since >= retry) return "retry";
    await sleep(pollMs);
  }
}

const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
/** Tokens that count toward budgets and alerts: new input (not read from a prompt cache) plus output.
 *  Cache reads cost about a tenth and dominate long CLI sessions, so they are reported but not counted. */
export const countedTokens = ({ input = 0, cached = 0, output = 0 }) => Math.max(0, input - cached) + output;
export const runTokens = () => countedTokens(RUN.usage);
const money = (usd) => `$${usd.toFixed(2)}`;
const n = (value) => value.toLocaleString("en-US");

/** Watches this run's token and spend use; the day's totals carry over between runs in <state>/usage-day.json. */
export async function watchUsage(state, stateDir) {
  watched = { state, stateDir };
  let saved = null;
  try { saved = JSON.parse(await readFile(path.join(stateDir, "usage-day.json"), "utf8")); } catch { /* first run today */ }
  RUN.day = saved?.date === today() ? { date: saved.date, tokens: Number(saved.tokens) || 0, costUsd: Number(saved.costUsd) || 0 } : { date: today(), tokens: 0, costUsd: 0 };
}

/** One CLI call's usage: input tokens (cache reads included, and also given as cached), output tokens, and cost when the CLI reports it.
 *  Without a reported cost, the model's entry in the price table (if any) estimates it.
 *  A budget asks for Stop like the other limits, so the work that crosses it still finishes. */
export async function recordUsage({ input = 0, cached = 0, output = 0, costUsd = 0, model = null } = {}) {
  const clean = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0);
  input = clean(input); cached = clean(cached); output = clean(output); costUsd = clean(costUsd);
  if (!input && !output && !costUsd) return;
  const estimated = costUsd ? 0 : estimateCost({ input, cached, output }, model);
  await addRunUsage({ input, cached, output, costUsd: costUsd + estimated, estimatedUsd: estimated, calls: 1 });
}

/** Adds usage already priced to the run and the day: one call's, or the run totals of a parallel task's
 *  engine (its run-report usage; that engine counted its calls only in its own state folder). */
export async function addRunUsage({ input = 0, cached = 0, output = 0, costUsd = 0, estimatedUsd = 0, calls = 0 } = {}) {
  const clean = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0);
  input = clean(input); cached = clean(cached); output = clean(output); costUsd = clean(costUsd); estimatedUsd = clean(estimatedUsd); calls = clean(calls);
  if (!input && !output && !costUsd) return;
  Object.assign(RUN.usage, { input: RUN.usage.input + input, cached: RUN.usage.cached + cached, output: RUN.usage.output + output, costUsd: RUN.usage.costUsd + costUsd, estimatedUsd: RUN.usage.estimatedUsd + estimatedUsd, calls: RUN.usage.calls + calls });
  if (RUN.day.date !== today()) RUN.day = { date: today(), tokens: 0, costUsd: 0 };
  RUN.day.tokens += countedTokens({ input, cached, output }); RUN.day.costUsd += costUsd;
  if (!watched) return;
  const { state, stateDir } = watched, day = { ...RUN.day };
  dayWrite = dayWrite.then(() => atomicWriteJson(path.join(stateDir, "usage-day.json"), day)).catch(() => {});
  await dayWrite;
  if (RUN.maxTokens && runTokens() >= RUN.maxTokens) await reachLimit(state, "tokens", `Token budget reached: ${n(runTokens())} of ${n(RUN.maxTokens)} tokens this run.`);
  else if (RUN.maxCost && RUN.usage.costUsd >= RUN.maxCost) await reachLimit(state, "cost", `Spend budget reached: ${money(RUN.usage.costUsd)} of ${money(RUN.maxCost)} this run.`);
  else if (RUN.maxTokensDay && RUN.day.tokens >= RUN.maxTokensDay) await reachLimit(state, "tokens-day", `Daily token budget reached: ${n(RUN.day.tokens)} of ${n(RUN.maxTokensDay)} tokens today.`);
  else if (RUN.maxCostDay && RUN.day.costUsd >= RUN.maxCostDay) await reachLimit(state, "cost-day", `Daily spend budget reached: ${money(RUN.day.costUsd)} of ${money(RUN.maxCostDay)} today.`);
}

/** Records usage without ever failing the worker that reports it; `model` lets the price table cover CLIs that report no cost. */
export function noteUsage(usage, model = null) {
  if (usage) recordUsage(model && !usage.model ? { ...usage, model } : usage).catch(() => {});
}

/** claude -p --output-format json: the result envelope's usage and total_cost_usd. */
export function claudeUsage(stdout) {
  let envelope;
  try { envelope = JSON.parse(String(stdout).trim().split(/\r?\n/).filter(Boolean).at(-1)); } catch { return null; }
  const u = envelope?.usage;
  if (!u && envelope?.total_cost_usd === undefined) return null;
  // Cache writes cost more than plain input, so only cache reads are "cached".
  const cached = Number(u?.cache_read_input_tokens) || 0;
  return { input: (Number(u?.input_tokens) || 0) + (Number(u?.cache_creation_input_tokens) || 0) + cached, cached, output: Number(u?.output_tokens) || 0, costUsd: Number(envelope.total_cost_usd) || 0 };
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
    const t = event.part?.tokens ?? {}, cached = Number(t.cache?.read) || 0;
    found = true;
    total.input += (Number(t.input) || 0) + (Number(t.cache?.write) || 0) + cached; total.cached += cached;
    total.output += (Number(t.output) || 0) + (Number(t.reasoning) || 0); total.costUsd += Number(event.part?.cost) || 0;
  }
  return found ? total : null;
}

/**
 * cline --json: the final run_result's usage (any provider, Ollama included). Cache reads are not
 * part of inputTokens, as with Claude.
 */
export function clineUsage(runResult) {
  const u = runResult?.aggregateUsage ?? runResult?.usage;
  if (!u) return null;
  const cached = Number(u.cacheReadTokens) || 0;
  return { input: (Number(u.inputTokens) || 0) + (Number(u.cacheWriteTokens) || 0) + cached, cached, output: Number(u.outputTokens) || 0, costUsd: Number(u.totalCost) || 0 };
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
  if (event.type === "task-stepped-down") RUN.stepDowns++;
  if (event.type === "qa-pass") { RUN.tasksPassed++; RUN.planItems += Array.isArray(event.planItems) ? event.planItems.length : 0; RUN.approved.push({ taskId: event.taskId ?? state?.live?.task?.id ?? null, name: state?.live?.task?.name ?? null, at: new Date().toISOString() }); }
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
    // The configured task size (a step-down still in force at the end does not change it).
    taskMode: STEP_DOWN.active?.configured.taskMode ?? TUNING.taskMode, planItems: RUN.planItems, stepDowns: RUN.stepDowns,
    tasksApproved: RUN.tasksPassed, qaFailures: RUN.failures, corrections: RUN.corrections, elevations: RUN.elevations, needsAttention: RUN.attention,
    supervisorAlerts: result.supervisorAlerts ?? 0,
    approved: RUN.approved.slice(-200),
    usage: { tokens: runTokens(), input: RUN.usage.input, cached: RUN.usage.cached, output: RUN.usage.output, costUsd: Math.round(RUN.usage.costUsd * 10000) / 10000, estimatedUsd: Math.round(RUN.usage.estimatedUsd * 10000) / 10000, calls: RUN.usage.calls },
    limits: { maxTasks: RUN.maxTasks, maxHours: RUN.maxHours, maxElevations: RUN.maxElevations, maxTokens: RUN.maxTokens, maxCost: RUN.maxCost, maxTokensDay: RUN.maxTokensDay, maxCostDay: RUN.maxCostDay },
    // The chain head at the end of the run: a log later cut short no longer reaches this entry.
    actionLog: await flushActionLog().then(() => verifyActionLog(stateDir)).catch((error) => ({ ok: false, reason: error.message })),
  };
  report.reason = redactText(String(report.reason ?? ""));
  await atomicWriteJson(path.join(stateDir, "run-report.json"), report);
  // Run history: one copy per run (Overview › Runs); retention keeps the newest.
  await atomicWriteJson(path.join(stateDir, "runs", `${report.startedAt.replace(/[:.]/g, "-")}.json`), report).catch(() => {});
  const line = (label, value) => `- ${label}: ${value}`;
  await writeFile(path.join(stateDir, "run-report.md"), [
    `# Run report`, "",
    line("Mode", report.unattended ? "Unattended" : "Attended"), line("Task size", `${report.taskMode}${report.stepDowns ? ` (${report.stepDowns} step-down(s))` : ""}`), line("Started", report.startedAt), line("Ended", `${report.endedAt} (${report.hours} h)`),
    line("Result", report.status), line("Why it ended", String(report.reason ?? "").split(/\r?\n/)[0].slice(0, 300) || "finished"), "",
    line("Tasks approved", report.tasksApproved), line("Plan items finished", report.planItems), line("QA failures", report.qaFailures), line("Corrections", report.corrections), line("Elevations", report.elevations), line("Stops for attention", report.needsAttention), line("Supervisor alerts", `${report.supervisorAlerts} (see supervisor-digest.md)`), "",
    line("Tokens", `${n(report.usage.tokens)} counted toward limits (new input ${n(report.usage.input - report.usage.cached)} + output ${n(report.usage.output)}); ${n(report.usage.cached)} more read from prompt caches, not counted; ${report.usage.calls} call(s)`),
    line("Spend", `${money(report.usage.costUsd)}${report.usage.estimatedUsd ? ` (${money(report.usage.estimatedUsd)} estimated from the price table)` : ""}; CLIs that report no cost count only for models in the price table`), "",
    line("Action log", report.actionLog.ok ? `verified, ${report.actionLog.entries} entries, head ${report.actionLog.head}` : `NOT VERIFIED (entry ${report.actionLog.brokenAt ?? "?"}: ${report.actionLog.reason})`),
    line("Limits", `tasks ${report.limits.maxTasks || "none"}, hours ${report.limits.maxHours || "none"}, Elevations ${report.limits.maxElevations || "none"}, tokens ${report.limits.maxTokens ? n(report.limits.maxTokens) : "none"}, spend ${report.limits.maxCost ? money(report.limits.maxCost) : "none"}, tokens/day ${report.limits.maxTokensDay ? n(report.limits.maxTokensDay) : "none"}, spend/day ${report.limits.maxCostDay ? money(report.limits.maxCostDay) : "none"}`), "",
  ].join("\n"));
  return report;
}

/** Past runs, newest first (one report per run in <state>/runs). */
export async function listRuns(stateDir, limit = 100) {
  const dir = path.join(stateDir, "runs");
  let names = [];
  try { names = (await readdir(dir)).filter((n) => n.endsWith(".json")).sort().reverse().slice(0, limit); } catch { return []; }
  const runs = [];
  for (const name of names) { try { runs.push(JSON.parse(await readFile(path.join(dir, name), "utf8"))); } catch {} }
  return runs;
}
