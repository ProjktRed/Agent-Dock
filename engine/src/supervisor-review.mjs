import { readFile } from "node:fs/promises";
import path from "node:path";
import { RUN } from "./run-budget.mjs";
import { TUNING } from "./engine-tuning.mjs";

// Supervisor v2: when a monitor raises an alert, a model (Codex, Claude Code or a local
// OpenAI-compatible server) reviews the run and proposes actions from a fixed list. In "act" mode
// the allowed ones are carried out; everything else stays a proposal for you. The reviewer runs
// read-only and can never edit code, commit, approve QA, or loosen a guard, cap or path.
export const REVIEW_ACTIONS = ["none", "pause", "stop", "defer-task", "request-elevation", "tighten-cap", "switch-backup-cli", "retry-worker"];
/** Actions the engine carries out itself in act mode; the rest are proposals for you. */
export const ACTABLE = new Set(["pause", "stop", "defer-task", "request-elevation", "tighten-cap"]);
const CAPS = ["none", "corrections", "tasks", "tokens"];

export const REVIEW_SCHEMA = {
  type: "object", additionalProperties: false, required: ["summary", "actions"],
  properties: {
    summary: { type: "string" },
    actions: { type: "array", maxItems: 3, items: { type: "object", additionalProperties: false, required: ["action", "reason", "cap", "value"],
      properties: { action: { type: "string", enum: REVIEW_ACTIONS }, reason: { type: "string" }, cap: { type: "string", enum: CAPS }, value: { type: "number" } } } },
  },
};

/** Strict parse: unknown actions are dropped, never guessed. */
export function parseReview(text) {
  const raw = String(text ?? "").trim(), fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const value = JSON.parse(fenced ? fenced[1] : raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
  if (typeof value?.summary !== "string" || !Array.isArray(value.actions)) throw new Error("Supervisor review has no summary/actions");
  const actions = value.actions.filter((a) => REVIEW_ACTIONS.includes(a?.action) && a.action !== "none").slice(0, 3)
    .map((a) => ({ action: a.action, reason: String(a.reason ?? "").slice(0, 400), cap: CAPS.includes(a.cap) ? a.cap : "none", value: Number(a.value) || 0 }));
  return { summary: value.summary.slice(0, 1200), actions };
}

export function buildReviewPrompt({ alert, task, events, plan, deferred, mayDefer }) {
  return [
    "You are the Supervisor of an unattended coding run in Agent Dock. You review; you never write code.",
    "A monitor raised the alert below. Decide whether the run needs an action. Prefer no action when the loop's own limits (corrections, Elevation, run limits) will handle it.",
    "Allowed actions (at most 3):",
    "- pause: stop after the current step and wait for the human.",
    "- stop: end the run at the next safe point.",
    mayDefer ? "- defer-task: set the current task aside (its uncommitted work is stashed, not lost) and let Assessment choose another task. Use when the task is stuck and other work can continue." : "- defer-task: NOT allowed in this project; do not propose it.",
    "- request-elevation: ask the stronger Elevation model to revise the strategy for the current failing task.",
    "- tighten-cap: lower one limit (cap: corrections | tasks | tokens; value: the new, lower number). Never raise a limit.",
    "- switch-backup-cli / retry-worker: proposals for the human only.",
    "Use cap \"none\" and value 0 for actions other than tighten-cap. Reply with JSON only: {\"summary\": \"…\", \"actions\": [...]}.",
    "",
    `Alert: ${alert.monitor}: ${alert.message}`,
    `Run so far: ${RUN.tasksPassed} approved, ${RUN.failures} QA failures, ${RUN.corrections} corrections, ${RUN.elevations} Elevations, ${RUN.usage.input + RUN.usage.output} tokens.`,
    `Limits: corrections per task ${TUNING.maxCorrections || "none"}, tasks ${RUN.maxTasks || "none"}, tokens ${RUN.maxTokens || "none"}.`,
    task ? `Current task: ${task.id} — ${task.name ?? ""}; allowed paths: ${(task.allowedPaths ?? []).slice(0, 15).join(", ")}` : "Current task: none",
    plan?.total ? `Plan: ${plan.completed}/${plan.total} items done.` : "Plan: none",
    deferred.length ? `Already deferred: ${deferred.map((d) => `${d.id} (${d.reason})`).join("; ")}` : "",
    "",
    "Recent events (oldest first):",
    ...events.map((e) => `- ${e.timestamp ?? ""} ${e.type}: ${String(e.message ?? e.qa ?? e.action ?? "").split(/\r?\n/).find((l) => l.trim())?.slice(0, 200) ?? ""}`),
  ].filter((line) => line !== "").join("\n");
}

/** The reviewer model. Codex and Claude Code run read-only in their own state folder (no lock clash with the orchestrator). */
export async function createReviewer({ kind, model, baseUrl, stateDir, workspace, codexLauncher, options = {}, env = process.env, fetchImpl = fetch }) {
  if (!["codex", "claude", "local"].includes(kind)) throw new Error("--supervisor-reviewer must be codex, claude or local");
  if (kind === "local") {
    if (!baseUrl) throw new Error("The local Supervisor reviewer needs --supervisor-base-url");
    const url = new URL("chat/completions", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
    return async (prompt) => {
      const key = env.AGENT_DOCK_SUPERVISOR_KEY;
      const response = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({ model, temperature: 0, messages: [{ role: "user", content: prompt }], response_format: { type: "json_object" } }), signal: AbortSignal.timeout(5 * 60_000) });
      if (!response.ok) throw new Error(`Local reviewer answered HTTP ${response.status}`);
      return parseReview((await response.json())?.choices?.[0]?.message?.content);
    };
  }
  const reviewDir = path.join(stateDir, "supervisor-review");
  let worker;
  if (kind === "claude") {
    const { ClaudeWorker } = await import("./claude-worker.mjs");
    worker = new ClaudeWorker({ stateDir: reviewDir, workspace, claudeCommand: options["claude-command"] ?? "claude" });
  } else if (kind === "codex") {
    const { CodexWorker } = await import("./codex-worker.mjs");
    const { resolveCodexCommand } = await import("./codex-command.mjs");
    const launcher = codexLauncher ?? await resolveCodexCommand({ explicitCommand: options["codex-command"] ?? options["codex-exe"] });
    worker = new CodexWorker({ stateDir: reviewDir, workspace, launcher, windowsSandbox: options["codex-windows-sandbox"] });
  } else throw new Error("--supervisor-reviewer must be codex, claude or local");
  return (prompt) => worker.invoke(prompt, "read-only", { model: model || undefined, reasoningEffort: "medium", schema: REVIEW_SCHEMA, parse: parseReview });
}

export async function readDeferred(stateDir) {
  try { const list = JSON.parse(await readFile(path.join(stateDir, "deferred-tasks.json"), "utf8")); return Array.isArray(list) ? list : []; } catch { return []; }
}

/**
 * Carries out one proposed action, or explains why not. Only ever lowers a limit; defer needs the
 * project's "may defer" setting. Returns a short result line for Activity.
 */
export async function applyReviewAction(state, action, { mayDefer }) {
  if (!ACTABLE.has(action.action)) return "proposal for you";
  if (action.action === "pause" || action.action === "stop") { await state.setControl(action.action, { source: "supervisor-review" }); return `asked to ${action.action} at the next safe point`; }
  if (action.action === "defer-task") {
    if (!mayDefer) return "not done: deferring tasks is off for this project";
    await state.setControl("defer", { source: "supervisor-review", reason: action.reason || "Deferred by the Supervisor" });
    return "deferring at the next safe point";
  }
  if (action.action === "request-elevation") { await state.setControl("request-elevation", { source: "supervisor-review" }); return "Elevation requested for the failing task"; }
  // tighten-cap: only a lower, positive value is accepted.
  const value = Math.floor(action.value);
  const caps = { corrections: [TUNING, "maxCorrections"], tasks: [RUN, "maxTasks"], tokens: [RUN, "maxTokens"] };
  const target = caps[action.cap];
  if (!target || !(value > 0)) return "not done: no valid cap and value";
  const [object, key] = target, current = object[key];
  if (current && value >= current) return `not done: ${action.cap} ${value} is not lower than ${current}`;
  object[key] = value;
  return `${action.cap} limit lowered to ${value}${current ? ` (was ${current})` : ""}`;
}
