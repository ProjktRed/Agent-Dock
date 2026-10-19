import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { replaceWithRetry as rename } from "./fs-retry.mjs";
import path from "node:path";

// Plan stewardship (Supervisor 0.19.4): the reviewer may propose line edits to IMPLEMENTATION_PLAN.md.
// A proposal never changes the plan by itself. You approve it in the app; it is then applied between
// tasks (the workspace must be clean) as its own commit touching only the plan. The Supervisor can
// reword, add, split or remove open items, but never check one off and never touch a checked item or
// a heading: marking work done stays with QA.
export const PLAN_FILE = "IMPLEMENTATION_PLAN.md";
export const PROPOSALS_FILE = "plan-proposals.json";
export const TICKS_FILE = "plan-ticks.json";
export const PLAN_OPS = ["add", "edit", "remove"];
export const MAX_PLAN_EDITS = 8;
const KEEP = 50;
const CHECKED = /^\s*-\s+\[[xX]\]/;
const HEADING = /^#{1,6}\s/;

export const PLAN_EDITS_SCHEMA = {
  type: "object", additionalProperties: false, required: ["reason", "edits"],
  properties: {
    reason: { type: "string" },
    edits: { type: "array", maxItems: MAX_PLAN_EDITS, items: { type: "object", additionalProperties: false, required: ["op", "line", "text"],
      properties: { op: { type: "string", enum: PLAN_OPS }, line: { type: "string" }, text: { type: "string" } } } },
  },
};

/** Lenient read of a model's plan block: anything malformed becomes "no edits". */
export function parsePlanEdits(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.edits)) return { reason: "", edits: [] };
  const edits = value.edits.filter((e) => PLAN_OPS.includes(e?.op) && typeof e.line === "string").slice(0, MAX_PLAN_EDITS)
    .map((e) => ({ op: e.op, line: e.line.replace(/\r?\n[\s\S]*$/, "").trimEnd(), text: String(e.text ?? "").trimEnd() }));
  return { reason: String(value.reason ?? "").slice(0, 400), edits };
}

/**
 * Checks edits against the plan text and returns the new text, or the reasons it cannot apply.
 * Edits apply in order, each to the plan as the earlier ones left it (so "edit a line, then add
 * items after the new line" works). Each names a line exactly (trailing spaces ignored) that must
 * match one line only.
 */
export function checkPlanEdits(planText, edits) {
  const eol = /\r\n/.test(planText) ? "\r\n" : "\n";
  const original = String(planText).split(/\r?\n/), lines = [...original];
  const errors = [];
  if (!Array.isArray(edits) || !edits.length) errors.push("No edits");
  if (edits?.length > MAX_PLAN_EDITS) errors.push(`At most ${MAX_PLAN_EDITS} edits`);
  // A line an earlier edit rewrote can still be named by its old text.
  const rewritten = new Map();
  for (const [n, edit] of (edits ?? []).entries()) {
    const label = `Edit ${n + 1}`;
    if (!PLAN_OPS.includes(edit?.op)) { errors.push(`${label}: unknown operation`); continue; }
    const named = String(edit.line ?? "").trimEnd();
    const find = (t) => (t.trim() ? lines.flatMap((l, i) => (l.trimEnd() === t ? [i] : [])) : []);
    let target = named, matches = find(named);
    if (!matches.length && rewritten.has(named)) { target = rewritten.get(named); matches = find(target); }
    if (matches.length !== 1) { errors.push(`${label}: the line ${matches.length ? "appears more than once" : "is not in the plan"}: "${named.slice(0, 80)}"`); continue; }
    const index = matches[0];
    const text = String(edit.text ?? "").trimEnd();
    if (edit.op !== "remove") {
      if (/[\r\n]/.test(text) || !text.trim()) { errors.push(`${label}: the new text must be one non-empty line`); continue; }
      if (text.length > 300) { errors.push(`${label}: the new text is longer than 300 characters`); continue; }
      if (CHECKED.test(text) && !(edit.op === "edit" && CHECKED.test(lines[index]))) { errors.push(`${label}: the Supervisor cannot check off plan items`); continue; }
    }
    if (edit.op !== "add") {
      if (CHECKED.test(lines[index])) { errors.push(`${label}: checked items cannot be changed or removed`); continue; }
      if (HEADING.test(lines[index])) { errors.push(`${label}: headings cannot be changed or removed`); continue; }
    }
    if (edit.op === "add") lines.splice(index + 1, 0, text);
    else if (edit.op === "edit") { lines[index] = text; rewritten.set(target, text); for (const [k, v] of rewritten) if (v === target) rewritten.set(k, text); }
    else lines.splice(index, 1);
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, text: lines.join(eol), preview: lineDiff(original, lines) };
}

/** A small line diff for the preview: "@@ line N" hunks of -/+ lines (a pure insertion shows the line before it). */
export function lineDiff(a, b) {
  const lcs = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const ops = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { ops.push([" ", a[i], i]); i++; j++; }
    else if (j >= b.length || (i < a.length && lcs[i + 1][j] >= lcs[i][j + 1])) { ops.push(["-", a[i], i]); i++; }
    else { ops.push(["+", b[j], i]); j++; }
  }
  const out = [];
  for (let k = 0; k < ops.length; k++) {
    if (ops[k][0] === " ") continue;
    const start = k;
    while (k < ops.length && ops[k][0] !== " ") k++;
    const hunk = ops.slice(start, k);
    if (hunk.some(([t]) => t === "-")) out.push(`@@ line ${hunk.find(([t]) => t === "-")[2] + 1}`, ...hunk.map(([t, l]) => `${t} ${l}`));
    else {
      const before = start > 0 ? ops[start - 1] : null;
      out.push(`@@ line ${before ? before[2] + 1 : 1}`, ...(before ? [`  ${before[1]}`] : []), ...hunk.map(([t, l]) => `${t} ${l}`));
    }
  }
  return out.join("\n");
}

/** The plan as the reviewer sees it: phases with open items, in the file's exact lines, capped. */
export function planExcerpt(planText, maxChars = 6000) {
  const lines = String(planText ?? "").split(/\r?\n/), keep = [];
  let block = [], open = false;
  const flush = () => { if (open || !block.some((l) => /^\s*-\s+\[/.test(l))) keep.push(...block.filter((l) => l.trim())); block = []; open = false; };
  for (const line of lines) {
    if (/^##\s/.test(line)) flush();
    block.push(line);
    if (/^\s*-\s+\[ \]/.test(line)) open = true;
  }
  flush();
  let text = keep.join("\n");
  if (text.length > maxChars) text = `${text.slice(0, maxChars).replace(/\n[^\n]*$/, "")}\n(plan truncated)`;
  return text;
}

const proposalsPath = (stateDir) => path.join(stateDir, PROPOSALS_FILE);
export async function readPlanProposals(stateDir) {
  try { const list = JSON.parse(await readFile(proposalsPath(stateDir), "utf8")); return Array.isArray(list) ? list : []; } catch { return []; }
}
async function writeProposals(stateDir, list) {
  const file = proposalsPath(stateDir), temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(list.slice(-KEEP), null, 2));
  await rename(temp, file);
}
async function readPlan(workspace) {
  return readFile(path.join(workspace, PLAN_FILE), "utf8");
}
const hash = (text) => createHash("sha256").update(text).digest("hex");

/** A commit subject: the first sentence, cut at a word boundary. */
export function commitSubject(text, max = 64) {
  const first = String(text ?? "").split(/\r?\n/)[0].split(/(?<=[.!?])\s/)[0].trim().replace(/[.]$/, "");
  if (first.length <= max) return first;
  const cut = first.slice(0, max), space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[,;:]$/, "")}…`;
}

/** Stores a valid proposal (pending) and returns it, or returns { errors } and stores nothing. */
export async function proposePlanChange({ stateDir, workspace, reason, edits, source = "supervisor-review", state = null }) {
  let plan;
  try { plan = await readPlan(workspace); } catch { return { errors: [`${PLAN_FILE} is missing or unreadable`] }; }
  const check = checkPlanEdits(plan, edits);
  if (!check.ok) return { errors: check.errors };
  const proposal = { id: randomUUID(), at: new Date().toISOString(), source, reason: String(reason ?? "").slice(0, 400), edits, planHash: hash(plan), preview: check.preview, status: "pending" };
  await writeProposals(stateDir, [...await readPlanProposals(stateDir), proposal]);
  await state?.record({ type: "plan-proposal", id: proposal.id, message: proposal.reason, preview: proposal.preview, source });
  return proposal;
}

/** Proposals with a live check against today's plan (an approved one waits for the next task boundary). */
export async function listPlanProposals({ stateDir, workspace }) {
  const list = await readPlanProposals(stateDir);
  let plan = null;
  try { plan = await readPlan(workspace); } catch {}
  return list.map((p) => {
    if (!["pending", "approved"].includes(p.status)) return p;
    const check = plan === null ? { ok: false, errors: [`${PLAN_FILE} is missing`] } : checkPlanEdits(plan, p.edits);
    return { ...p, applies: check.ok, problem: check.ok ? null : check.errors.join("; "), preview: check.ok ? check.preview : p.preview };
  });
}

/** You decide: approve (applied between tasks) or dismiss. */
export async function decidePlanProposal({ stateDir, id, decision, source = "app", state = null }) {
  if (!["approve", "dismiss"].includes(decision)) throw new Error("decision must be approve or dismiss");
  const list = await readPlanProposals(stateDir), proposal = list.find((p) => p.id === id);
  if (!proposal) throw new Error("Plan proposal not found");
  if (!["pending", "approved"].includes(proposal.status)) throw new Error(`This proposal is already ${proposal.status}`);
  proposal.status = decision === "approve" ? "approved" : "dismissed";
  proposal.decidedAt = new Date().toISOString();
  proposal.decidedBy = source;
  await writeProposals(stateDir, list);
  await state?.record({ type: decision === "approve" ? "plan-proposal-approved" : "plan-proposal-dismissed", id, message: proposal.reason, source });
  return proposal;
}

function git(args, cwd) {
  return new Promise((resolve) => execFile("git", args, { cwd, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) =>
    resolve({ ok: !error, out: String(stdout), err: String(stderr || error?.message || "") })));
}

const normalizeItem = (text) => String(text ?? "").replace(/^\s*-\s+\[[ xX]\]\s+/, "").replace(/\s+/g, " ").trim();

/** QA approved a task that completes a plan item: queue the check-off for the next task boundary. */
export async function queuePlanTick({ stateDir, taskId, item }) {
  const text = normalizeItem(item);
  if (!text) return null;
  const file = path.join(stateDir, TICKS_FILE);
  let list = [];
  try { list = JSON.parse(await readFile(file, "utf8")); if (!Array.isArray(list)) list = []; } catch {}
  const tick = { taskId: taskId ?? null, item: text, at: new Date().toISOString() };
  list.push(tick);
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(list.slice(-50), null, 2));
  await rename(temp, file);
  return tick;
}

/** Checks off queued items: the one unchecked line with that text, as its own commit of the plan only. */
async function applyPlanTicks({ stateDir, workspace, state }) {
  const file = path.join(stateDir, TICKS_FILE);
  let ticks = [];
  try { ticks = JSON.parse(await readFile(file, "utf8")); } catch {}
  if (!Array.isArray(ticks) || !ticks.length) return 0;
  let done = 0;
  for (const tick of ticks) {
    let plan;
    try { plan = await readPlan(workspace); } catch { break; }
    const eol = /\r\n/.test(plan) ? "\r\n" : "\n", lines = plan.split(/\r?\n/);
    const matches = lines.flatMap((line, i) => (/^\s*-\s+\[ \]\s+/.test(line) && normalizeItem(line) === tick.item ? [i] : []));
    if (matches.length !== 1) {
      const already = lines.some((line) => /^\s*-\s+\[[xX]\]\s+/.test(line) && normalizeItem(line) === tick.item);
      if (!already) await state?.record({ type: "plan-tick-skipped", taskId: tick.taskId, message: `${matches.length ? "More than one" : "No"} unchecked plan item reads "${tick.item.slice(0, 120)}"; check it off yourself if it is done.` });
      continue;
    }
    lines[matches[0]] = lines[matches[0]].replace(/\[ \]/, "[x]");
    await writeFile(path.join(workspace, PLAN_FILE), lines.join(eol));
    const commit = await git(["commit", "-m", `Plan: check off ${commitSubject(tick.item, 56)}`, "-m", `Task ${tick.taskId ?? "?"} was approved by QA; checked off by Agent Dock.`, "--", PLAN_FILE], workspace);
    if (!commit.ok) { await writeFile(path.join(workspace, PLAN_FILE), plan); await state?.record({ type: "plan-tick-skipped", taskId: tick.taskId, message: `git commit failed: ${commit.err.trim().slice(0, 200)}` }); continue; }
    await state?.record({ type: "plan-item-done", taskId: tick.taskId, message: tick.item, commit: (await git(["rev-parse", "HEAD"], workspace)).out.trim() });
    done++;
  }
  await rm(file, { force: true });
  return done;
}

/**
 * Applies approved proposals, each as its own commit of the plan file only. Runs only at a task
 * boundary (or with no engine running) and only on a clean workspace, so no task ever sees it in its
 * diff. Returns how many were applied; a proposal that no longer fits is marked failed with the reason.
 */
export async function applyApprovedPlanProposals({ stateDir, workspace, state = null }) {
  const list = await readPlanProposals(stateDir), approved = list.filter((p) => p.status === "approved");
  let hasTicks = false;
  try { hasTicks = (await readFile(path.join(stateDir, TICKS_FILE), "utf8")).trim().length > 2; } catch {}
  if (!approved.length && !hasTicks) return { applied: 0 };
  const status = await git(["status", "--porcelain=v1", "--untracked-files=all"], workspace);
  if (!status.ok || status.out.trim()) return { applied: 0, waiting: "the workspace has uncommitted changes" };
  const ticked = hasTicks ? await applyPlanTicks({ stateDir, workspace, state }) : 0;
  if (!approved.length) return { applied: 0, ticked };
  let applied = 0;
  for (const proposal of approved) {
    let plan;
    try { plan = await readPlan(workspace); } catch { plan = null; }
    const check = plan === null ? { ok: false, errors: [`${PLAN_FILE} is missing`] } : checkPlanEdits(plan, proposal.edits);
    if (!check.ok) {
      Object.assign(proposal, { status: "failed", problem: check.errors.join("; "), decidedAt: new Date().toISOString() });
      await state?.record({ type: "plan-proposal-failed", id: proposal.id, message: proposal.problem });
      continue;
    }
    await writeFile(path.join(workspace, PLAN_FILE), check.text);
    const subject = `Plan: ${commitSubject(proposal.reason) || "Supervisor plan change"}`;
    const commit = await git(["commit", "-m", subject, "-m", `Proposed by the Agent Dock Supervisor and approved in Agent Dock (proposal ${proposal.id}).`, "--", PLAN_FILE], workspace);
    if (!commit.ok) {
      await writeFile(path.join(workspace, PLAN_FILE), plan);
      Object.assign(proposal, { status: "failed", problem: `git commit failed: ${commit.err.trim().slice(0, 300)}`, decidedAt: new Date().toISOString() });
      await state?.record({ type: "plan-proposal-failed", id: proposal.id, message: proposal.problem });
      continue;
    }
    const sha = (await git(["rev-parse", "HEAD"], workspace)).out.trim();
    Object.assign(proposal, { status: "applied", appliedAt: new Date().toISOString(), commit: sha, preview: check.preview });
    await state?.record({ type: "plan-proposal-applied", id: proposal.id, message: proposal.reason, commit: sha });
    applied++;
  }
  await writeProposals(stateDir, list);
  return { applied, ticked };
}
