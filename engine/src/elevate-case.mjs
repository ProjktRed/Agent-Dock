import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

async function readJson(file, fallback = null) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}

export function computeElevateFingerprint({ task, qaPacket, qaVerdict, diff, failureReason, correctionHistory }) {
  return createHash("sha256").update(JSON.stringify(stable({ task, qaPacket, qaVerdict, diff, failureReason, correctionHistory }))).digest("hex");
}

export function elevateAvailability({ live, fingerprint }) {
  if (live?.stage === 'BLOCKED' || !(live?.userAttention || (live?.stage === "manual-review" && live.manualReview))) return { available: false, reason: "User Attention is not active" };
  if (!live.task) return { available: false, reason: "No current task" };
  if (!live.latestQa) return { available: false, reason: "No QA failure information" };
  if (live.clineStatus === "running" || live.qaStatus === "running" || live.elevateRunning || live.assessmentRunning || live.activeReasoningRole || live.codexOperation?.status === "running") return { available: false, reason: "A worker is active" };
  if (!fingerprint) return { available: false, reason: "The manual-review evidence is incomplete" };
  if (live.elevateUsedForFingerprint === fingerprint) return { available: false, reason: "This unchanged failure was already elevated" };
  return { available: true, reason: null };
}

async function readScopedCurrentDiff(workspace, task, fallback) {
  if (!workspace || !task?.allowedPaths?.length) return fallback;
  try {
    const args = ["diff", "--no-ext-diff", "--binary", "HEAD", "--", ...task.allowedPaths];
    const patch = (await exec("git", args, { cwd: workspace, windowsHide: true, maxBuffer: 8 * 1024 * 1024 })).stdout;
    const status = (await exec("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...task.allowedPaths], { cwd: workspace, windowsHide: true })).stdout;
    const untracked = [];
    for (const record of status.split("\0").filter(Boolean)) {
      if (!record.startsWith("?? ")) continue;
      const relative = record.slice(3).replaceAll("\\", "/");
      const content = await readFile(path.join(workspace, relative));
      untracked.push(`\nUNTRACKED ${relative}\n${content.toString("base64")}\n`);
    }
    const scopedPatch = patch + untracked.join("");
    return { bytes: Buffer.byteLength(scopedPatch), patch: scopedPatch };
  } catch {
    return fallback;
  }
}

export async function loadElevateCase(stateDir) {
  const [taskFile, qaPacket, lastResult, live] = await Promise.all([
    readJson(path.join(stateDir, "current-task.json")), readJson(path.join(stateDir, "qa-packet.json")),
    readJson(path.join(stateDir, "last-result.json")), readJson(path.join(stateDir, "live.json")),
  ]);
  const task = taskFile ? Object.fromEntries(Object.entries(taskFile).filter(([key]) => key !== "automation")) : live?.task;
  const qaVerdict = lastResult?.result?.qa ?? null;
  const failureReason = qaVerdict?.output ?? live?.latestQa ?? "";
  const correctionHistory = (lastResult?.result?.history ?? []).map((entry) => entry.qa?.correction?.trim()).filter(Boolean);
  const currentDiff = await readScopedCurrentDiff(live?.workspace, task, qaPacket?.diff ?? null);
  const fingerprint = computeElevateFingerprint({ task, qaPacket, qaVerdict, diff: currentDiff, failureReason, correctionHistory });
  return {
    task, qaPacket, latestQaVerdict: qaVerdict, currentDiff,
    failure: { reason: failureReason, cause: qaVerdict?.manualReviewCause ?? null },
    previousCorrections: correctionHistory, fingerprint,
  };
}
