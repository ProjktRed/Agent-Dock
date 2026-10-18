import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

// Plan stewardship (Supervisor 0.19.4): the reviewer may propose line edits to IMPLEMENTATION_PLAN.md.
// A proposal never changes the plan by itself. You approve it in the app; it is then applied between
// tasks (the workspace must be clean) as its own commit touching only the plan. The Supervisor can
// reword, add, split or remove open items, but never check one off and never touch a checked item or
// a heading: marking work done stays with QA.
export const PLAN_FILE = "IMPLEMENTATION_PLAN.md";
export const PROPOSALS_FILE = "plan-proposals.json";
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
 * Each edit names an existing line exactly (trailing spaces ignored); it must match one line only.
 */
export function checkPlanEdits(planText, edits) {
  const eol = /\r\n/.test(planText) ? "\r\n" : "\n";
  const lines = String(planText).split(/\r?\n/);
  const errors = [];
  if (!Array.isArray(edits) || !edits.length) errors.push("No edits");
  if (edits?.length > MAX_PLAN_EDITS) errors.push(`At most ${MAX_PLAN_EDITS} edits`);
  const changes = new Map();
  const at = (index) => changes.get(index) ?? changes.set(index, { replace: undefined, adds: [] }).get(index);
  for (const [n, edit] of (edits ?? []).entries()) {
    const label = `Edit ${n + 1}`;
    if (!PLAN_OPS.includes(edit?.op)) { errors.push(`${label}: unknown operation`); continue; }
    const target = String(edit.line ?? "").trimEnd();
    const matches = target.trim() ? lines.flatMap((l, i) => (l.trimEnd() === target ? [i] : [])) : [];
    if (matches.length !== 1) { errors.push(`${label}: the line ${matches.length ? "appears more than once" : "is not in the plan"}: "${target.slice(0, 80)}"`); continue; }
    const index = matches[0];
    if (edit.op !== "remove") {
      const text = String(edit.text ?? "");
      if (/[\r\n]/.test(text) || !text.trim()) { errors.push(`${label}: the new text must be one non-empty line`); continue; }
      if (text.length > 300) { errors.push(`${label}: the new text is longer than 300 characters`); continue; }
      if (CHECKED.test(text) && !(edit.op === "edit" && CHECKED.test(lines[index]))) { errors.push(`${label}: the Supervisor cannot check off plan items`); continue; }
    }
    if (edit.op !== "add") {
      if (CHECKED.test(lines[index])) { errors.push(`${label}: checked items cannot be changed or removed`); continue; }
      if (HEADING.test(lines[index])) { errors.push(`${label}: headings cannot be changed or removed`); continue; }
      const change = at(index);
      if (change.replace !== undefined) { errors.push(`${label}: the same line is edited twice`); continue; }
      change.replace = edit.op === "remove" ? null : edit.text;
    } else at(index).adds.push(edit.text);
  }
  if (errors.length) return { ok: false, errors };
  const out = [], preview = [];
  lines.forEach((line, index) => {
    const change = changes.get(index);
    if (!change) return out.push(line);
    preview.push(`@@ line ${index + 1}`);
    if (change.replace === undefined) { out.push(line); preview.push(`  ${line}`); }
    else { preview.push(`- ${line}`); if (change.replace !== null) { out.push(change.replace); preview.push(`+ ${change.replace}`); } }
    for (const add of change.adds) { out.push(add); preview.push(`+ ${add}`); }
  });
  return { ok: true, text: out.join(eol), preview: preview.join("\n") };
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

/**
 * Applies approved proposals, each as its own commit of the plan file only. Runs only at a task
 * boundary (or with no engine running) and only on a clean workspace, so no task ever sees it in its
 * diff. Returns how many were applied; a proposal that no longer fits is marked failed with the reason.
 */
export async function applyApprovedPlanProposals({ stateDir, workspace, state = null }) {
  const list = await readPlanProposals(stateDir), approved = list.filter((p) => p.status === "approved");
  if (!approved.length) return { applied: 0 };
  const status = await git(["status", "--porcelain=v1", "--untracked-files=all"], workspace);
  if (!status.ok || status.out.trim()) return { applied: 0, waiting: "the workspace has uncommitted changes" };
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
    const subject = `Plan: ${(proposal.reason || "Supervisor plan change").split(/\r?\n/)[0].slice(0, 72)}`;
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
  return { applied };
}
