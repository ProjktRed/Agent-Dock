import { execFile } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { replaceWithRetry as rename } from "./fs-retry.mjs";
import path from "node:path";

// Plan check-offs: when QA approves a task that completes an IMPLEMENTATION_PLAN.md item, the engine checks it off
// between tasks (the workspace must be clean), as its own commit touching only the plan. Marking work done stays
// with QA; nothing else edits the plan.
export const PLAN_FILE = "IMPLEMENTATION_PLAN.md";
export const TICKS_FILE = "plan-ticks.json";

async function readPlan(workspace) {
  return readFile(path.join(workspace, PLAN_FILE), "utf8");
}

/** A commit subject: the first sentence, cut at a word boundary. */
export function commitSubject(text, max = 64) {
  const first = String(text ?? "").split(/\r?\n/)[0].split(/(?<=[.!?])\s/)[0].trim().replace(/[.]$/, "");
  if (first.length <= max) return first;
  const cut = first.slice(0, max), space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[,;:]$/, "")}…`;
}

function git(args, cwd) {
  return new Promise((resolve) => execFile("git", args, { cwd, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) =>
    resolve({ ok: !error, out: String(stdout), err: String(stderr || error?.message || "") })));
}

const normalizeItem = (text) => String(text ?? "").replace(/^\s*-\s+\[[ xX]\]\s+/, "").replace(/\s+/g, " ").trim();
// An item copied from the Task priority list may carry its "[key]" or a "Phase N:" label in front.
const unlabelled = (text) => text.replace(/^\[[0-9a-f]{6,40}\]\s*/i, "").replace(/^Phase\s+\d+\s*[:·.-]\s*/i, "");

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
    const find = (item) => lines.flatMap((line, i) => (/^\s*-\s+\[ \]\s+/.test(line) && normalizeItem(line) === item ? [i] : []));
    let matches = find(tick.item);
    if (!matches.length && unlabelled(tick.item) !== tick.item) matches = find(unlabelled(tick.item));
    if (matches.length !== 1) {
      const already = lines.some((line) => /^\s*-\s+\[[xX]\]\s+/.test(line) && [tick.item, unlabelled(tick.item)].includes(normalizeItem(line)));
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
 * Applies queued check-offs at a task boundary (or with no engine running), only on a clean workspace, so no task
 * ever sees them in its diff.
 */
export async function applyPlanTicksBetweenTasks({ stateDir, workspace, state = null }) {
  let hasTicks = false;
  try { hasTicks = (await readFile(path.join(stateDir, TICKS_FILE), "utf8")).trim().length > 2; } catch {}
  if (!hasTicks) return { ticked: 0 };
  const status = await git(["status", "--porcelain=v1", "--untracked-files=all"], workspace);
  if (!status.ok || status.out.trim()) return { ticked: 0, waiting: "the workspace has uncommitted changes" };
  return { ticked: await applyPlanTicks({ stateDir, workspace, state }) };
}
