import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { readImplementationProgress } from "./implementation-progress.mjs";
import { RUN, runTokens } from "./run-budget.mjs";
import { notify } from "./notify.mjs";
import { applyReviewAction, buildReviewPrompt, readDeferred } from "./supervisor-review.mjs";
import { PLAN_FILE, proposePlanChange } from "./plan-stewardship.mjs";

// Supervisor v1: deterministic monitors over the loop's own events. It raises alerts (Activity,
// desktop, webhook/Discord) and, when allowed, asks for Pause or Stop at the next safe point.
// It never edits code, commits, approves QA, or loosens a guard, cap or path.
export const SUPERVISOR = {
  mode: "alert", // off | alert | pause | stop
  stallMinutes: 30, repeatFailures: 3, refusals: 5, tokensPerTask: 0, planDrift: 3, scopePaths: 25, digestHours: 0,
  // v2: a model reviews each alert (off | propose | act); defer needs mayDefer; at most reviewMax reviews per run, 10 min apart.
  review: "off", mayDefer: false, reviewMax: 6,
  // 0.19.4: the review may also propose IMPLEMENTATION_PLAN.md edits (always proposals; you approve each).
  planProposals: true,
};
const REVIEW_GAP_MS = 10 * 60_000;
const DEFAULTS = { ...SUPERVISOR };
const REFUSAL_WINDOW_MS = 10 * 60_000;
const MODES = new Set(["off", "alert", "pause", "stop"]);
const WAITING = new Set(["paused", "stopped", "USER_ATTENTION", "BLOCKED", "manual-review", "WAITING_FOR_CODEX", "waiting-for-codex", "usage-limit"]);

let S = null; // per-run tracking

function whole(value, flag, { decimal = false } = {}) {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || (!decimal && !Number.isInteger(n))) throw new Error(`--${flag} must be a ${decimal ? "number" : "whole number"} of at least 0`);
  return n;
}

/** --supervisor off|alert|pause|stop and --sv-* thresholds (0 turns that monitor off). */
export function parseSupervisorOptions(options) {
  const mode = options.supervisor ?? DEFAULTS.mode;
  if (!MODES.has(mode)) throw new Error("--supervisor must be off, alert, pause or stop");
  const read = { stallMinutes: whole(options["sv-stall-minutes"], "sv-stall-minutes", { decimal: true }), repeatFailures: whole(options["sv-repeat-failures"], "sv-repeat-failures"),
    refusals: whole(options["sv-refusals"], "sv-refusals"), tokensPerTask: whole(options["sv-tokens-per-task"], "sv-tokens-per-task"),
    planDrift: whole(options["sv-plan-drift"], "sv-plan-drift"), scopePaths: whole(options["sv-scope-paths"], "sv-scope-paths"), digestHours: whole(options["sv-digest-hours"], "sv-digest-hours", { decimal: true }),
    reviewMax: whole(options["sv-review-max"], "sv-review-max") };
  const review = options["supervisor-review"] ?? DEFAULTS.review;
  if (!["off", "propose", "act"].includes(review)) throw new Error("--supervisor-review must be off, propose or act");
  const mayDefer = options["supervisor-may-defer"] === undefined ? false : options["supervisor-may-defer"] === "true" ? true : options["supervisor-may-defer"] === "false" ? false : (() => { throw new Error("--supervisor-may-defer must be true or false"); })();
  const planOpt = options["sv-plan-proposals"];
  if (planOpt !== undefined && !["true", "false"].includes(planOpt)) throw new Error("--sv-plan-proposals must be true or false");
  const planProposals = planOpt === undefined ? DEFAULTS.planProposals : planOpt === "true";
  return { ...DEFAULTS, ...Object.fromEntries(Object.entries(read).filter(([, v]) => v !== undefined)), mode, review, mayDefer, planProposals };
}

/** Starts supervising this run. Returns a stop function that clears its timers. */
export function startSupervisor(state, { workspace, stateDir, config = {}, now = Date.now, reviewer = null } = {}) {
  Object.assign(SUPERVISOR, DEFAULTS, config);
  S = { reviewer, reviews: 0, lastReviewAt: -Infinity, reviewing: null, state, workspace, stateDir, now, lastEventAt: now(), stallAlerted: 0, taskId: state.live?.task?.id ?? null, failures: [], refusals: [],
    taskStartTokens: runTokens(), burnAlerted: false, passesSincePlanMove: 0, planCompleted: null, alerts: [], digestAt: now() };
  if (SUPERVISOR.mode === "off") return () => {};
  const timer = setInterval(() => void tick().catch(() => {}), 60_000);
  timer.unref();
  return () => clearInterval(timer);
}

export function supervisorAlerts() { return S?.alerts ?? []; }

async function alert(monitor, message, { act = false } = {}) {
  const action = act && SUPERVISOR.mode !== "alert" ? SUPERVISOR.mode : null;
  const entry = { monitor, message, action, at: new Date(S.now()).toISOString() };
  S.alerts.push(entry);
  if (action) await S.state.setControl(action, { source: "supervisor" });
  await S.state.record({ type: "supervisor-alert", monitor, message, ...(action ? { action } : {}) });
  notify({ type: "supervisor-alert", title: `Supervisor: ${monitor}`, message: action ? `${message} Asked to ${action} at the next safe point.` : message, urgent: Boolean(action) });
  queueReview(entry);
}

/** One model review at a time, at most reviewMax per run and 10 minutes apart; the loop never waits for it. */
function queueReview(entry) {
  if (!S.reviewer || SUPERVISOR.review === "off" || S.reviewing) return;
  if (S.reviews >= SUPERVISOR.reviewMax || S.now() - S.lastReviewAt < REVIEW_GAP_MS) return;
  S.reviews++; S.lastReviewAt = S.now();
  const run = S;
  S.reviewing = review(run, entry).catch(async (error) => {
    await run.state.record({ type: "supervisor-review-failed", message: error.message }).catch(() => {});
  }).finally(() => { run.reviewing = null; });
}

async function review(run, alertEntry) {
  const live = await run.state.readLive().catch(() => null);
  const events = (await run.state.readEvents(30).catch(() => [])).filter((e) => !/delta$|^cline-thinking/.test(e.type ?? ""));
  const plan = run.workspace ? await readImplementationProgress(run.workspace, {}) : null;
  const deferred = run.stateDir ? await readDeferred(run.stateDir) : [];
  const planText = SUPERVISOR.planProposals && run.workspace ? await readFile(path.join(run.workspace, PLAN_FILE), "utf8").catch(() => null) : null;
  const result = await run.reviewer(buildReviewPrompt({ alert: alertEntry, task: live?.task ?? null, events, plan, deferred, mayDefer: SUPERVISOR.mayDefer, planText, planProposals: SUPERVISOR.planProposals }));
  const actions = [];
  for (const action of result.actions) {
    const outcome = SUPERVISOR.review === "act" ? await applyReviewAction(run.state, action, { mayDefer: SUPERVISOR.mayDefer }) : "proposed";
    actions.push({ ...action, result: outcome });
  }
  await run.state.record({ type: "supervisor-review", mode: SUPERVISOR.review, monitor: alertEntry.monitor, message: result.summary, actions });
  // Plan edits are never applied here: a valid set becomes a proposal you approve or dismiss in the app.
  if (SUPERVISOR.planProposals && planText !== null && result.plan?.edits?.length && run.stateDir) {
    const proposal = await proposePlanChange({ stateDir: run.stateDir, workspace: run.workspace, reason: result.plan.reason, edits: result.plan.edits, state: run.state });
    if (proposal.errors) await run.state.record({ type: "plan-proposal-refused", message: proposal.errors.join("; ") });
    else notify({ type: "plan-proposal", title: "Supervisor: plan change proposed", message: [proposal.reason || "Plan edit", proposal.preview, "Approve or dismiss it in Agent Dock (Overview → Progress)."].join("\n") });
  }
  const lines = actions.map((a) => `${a.action}${a.action === "tighten-cap" ? ` ${a.cap} → ${a.value}` : ""}: ${a.result}`);
  notify({ type: "supervisor-review", title: "Supervisor review", message: [result.summary, ...lines].join("\n") });
}

/** Waits for a review still running (end of run). */
export async function awaitSupervisorReview() {
  await S?.reviewing;
}

/** Normalised first lines of a QA failure, so the same failure with other numbers still matches. */
export function failureSignature(text) {
  return String(text ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 3).join(" ").replace(/\d+(\.\d+)?/g, "#").replace(/\s+/g, " ").slice(0, 240).toLowerCase();
}

const REFUSAL = /refus|denied|not allowed|protected path|outside (the )?allowed|blocked/i;

/** Called with every loop event after it is recorded. */
export async function superviseEvent(event) {
  if (!S || SUPERVISOR.mode === "off") return;
  S.lastEventAt = S.now(); S.stallAlerted = 0;
  const taskId = event.taskId ?? S.state.live?.task?.id ?? null;
  // Assessment runs under the pseudo task "assessment"; its tokens count toward the task it chooses.
  if (taskId && taskId !== S.taskId) {
    const fromAssessment = S.taskId === "assessment";
    S.taskId = taskId; S.failures = [];
    if (!fromAssessment) { S.taskStartTokens = runTokens(); S.burnAlerted = false; }
  }
  const taskName = taskId === "assessment" ? "Assessment (choosing the next task)" : taskId;

  if ((event.type === "retry" || event.type === "qa-fail") && SUPERVISOR.repeatFailures) {
    S.failures.push(failureSignature(event.qa));
    // Length of the run of identical failures at the end; alert at N, 2N, … in a row.
    const last = S.failures.at(-1);
    let streak = 0;
    for (let i = S.failures.length - 1; i >= 0 && last && S.failures[i] === last; i--) streak++;
    if (streak && streak % SUPERVISOR.repeatFailures === 0)
      await alert("repeat failure", `${taskId ?? "The task"} failed QA ${SUPERVISOR.repeatFailures} times in a row with the same failure: ${String(event.qa ?? "").split(/\r?\n/).find((l) => l.trim())?.slice(0, 160) ?? ""}`, { act: true });
  }

  const refused = event.type === "implementation-scope-blocked" || event.type === "cline-guard-stopped" || (event.type === "cline-tool-failed" && REFUSAL.test(String(event.message ?? "")));
  if (refused && SUPERVISOR.refusals) {
    const t = S.now();
    S.refusals = [...S.refusals.filter((at) => t - at < REFUSAL_WINDOW_MS), t];
    if (S.refusals.length === SUPERVISOR.refusals) await alert("guard refusals", `${SUPERVISOR.refusals} guard refusals within 10 minutes; the worker keeps trying something it is not allowed to do.`);
    if (S.refusals.length === SUPERVISOR.refusals * 2) await alert("guard refusals", `${SUPERVISOR.refusals * 2} guard refusals within 10 minutes.`, { act: true });
  }

  if (SUPERVISOR.tokensPerTask) {
    const used = runTokens() - S.taskStartTokens;
    if (!S.burnAlerted && used >= SUPERVISOR.tokensPerTask) { S.burnAlerted = true; await alert("burn rate", `${taskName ?? "This task"} has used ${used.toLocaleString("en-US")} tokens, over the ${SUPERVISOR.tokensPerTask.toLocaleString("en-US")} per-task threshold.`); }
    else if (S.burnAlerted !== "acted" && used >= SUPERVISOR.tokensPerTask * 2) { S.burnAlerted = "acted"; await alert("burn rate", `${taskName ?? "This task"} has used ${used.toLocaleString("en-US")} tokens, twice the per-task threshold.`, { act: true }); }
  }

  if (event.type === "qa-pass") {
    S.failures = []; S.taskStartTokens = runTokens(); S.burnAlerted = false;
    if (SUPERVISOR.planDrift && S.workspace) {
      const plan = await readImplementationProgress(S.workspace, {});
      if (plan.total) {
        if (S.planCompleted === null || plan.completed !== S.planCompleted) { S.planCompleted = plan.completed; S.passesSincePlanMove = 0; }
        else if (++S.passesSincePlanMove === SUPERVISOR.planDrift) await alert("plan drift", `${SUPERVISOR.planDrift} tasks approved without checking off an IMPLEMENTATION_PLAN.md item (${plan.completed}/${plan.total} done). The run may be working outside the plan.`);
      }
    }
  }
}

/** Called when a task is chosen: broad or very long allowed-path lists are scope creep. */
export async function superviseTask(task) {
  if (!S || SUPERVISOR.mode === "off" || !SUPERVISOR.scopePaths || !Array.isArray(task?.allowedPaths)) return;
  const broad = task.allowedPaths.filter((p) => /^(\.|\*|\*\*|\/|\.\/|\*\*\/\*|[^/\\]+\/\*\*)$/.test(String(p).trim()));
  if (task.allowedPaths.length > SUPERVISOR.scopePaths) await alert("scope creep", `${task.id ?? "The task"} allows ${task.allowedPaths.length} paths (threshold ${SUPERVISOR.scopePaths}); tasks are meant to be bounded.`);
  else if (broad.length) await alert("scope creep", `${task.id ?? "The task"} allows broad paths: ${broad.join(", ")}.`);
}

async function tick() {
  if (!S) return;
  const t = S.now();
  // Waiting for you (paused, attention, blocked, usage limit) is not a stall.
  const live = await S.state.readLive().catch(() => null);
  if (WAITING.has(live?.stage) || live?.userAttention) S.lastEventAt = t;
  const idle = (t - S.lastEventAt) / 60_000;
  if (SUPERVISOR.stallMinutes && idle >= SUPERVISOR.stallMinutes * (S.stallAlerted + 1) && S.stallAlerted < 2) {
    S.stallAlerted++;
    await alert("stall", `No engine activity for ${Math.round(idle)} minutes${S.taskId ? ` on ${S.taskId}` : ""}.`);
  }
  if (SUPERVISOR.digestHours && t - S.digestAt >= SUPERVISOR.digestHours * 3_600_000) { S.digestAt = t; await digest("periodic"); }
}

/** Short summary of the run so far, as an event, a notification and supervisor-digest.md. */
export async function digest(kind = "periodic") {
  if (!S) return null;
  const plan = S.workspace ? await readImplementationProgress(S.workspace, {}) : null;
  const hours = Math.round(((S.now() - RUN.startedAt) / 3_600_000) * 10) / 10;
  const text = [`${RUN.tasksPassed} task(s) approved, ${RUN.failures} QA failure(s), ${RUN.corrections} correction(s), ${RUN.elevations} Elevation(s) in ${hours} h.`,
    `Tokens ${runTokens().toLocaleString("en-US")}${RUN.usage.costUsd ? `, reported spend $${RUN.usage.costUsd.toFixed(2)}` : ""}.`,
    plan?.total ? `Plan ${plan.completed}/${plan.total} (${plan.percent}%).` : null,
    `Supervisor alerts: ${S.alerts.length}${S.alerts.length ? ` (latest: ${S.alerts.at(-1).monitor})` : ""}.`].filter(Boolean).join(" ");
  await S.state.record({ type: "supervisor-digest", kind, message: text });
  if (S.stateDir) await writeFile(path.join(S.stateDir, "supervisor-digest.md"), `# Supervisor digest (${kind})\n\n${new Date(S.now()).toISOString()}\n\n${text}\n\n## Alerts\n\n${S.alerts.map((a) => `- ${a.at} ${a.monitor}: ${a.message}${a.action ? ` (asked to ${a.action})` : ""}`).join("\n") || "- none"}\n`).catch(() => {});
  notify({ type: "supervisor-digest", title: kind === "final" ? "Run finished" : "Supervisor digest", message: text });
  return text;
}

/** Runs one timer check now (tests). */
export const tickForTest = () => tick();
