// The recording shape, shared by capture.mjs and replay.mjs so a recording and its replay cannot
// disagree about how a decision is written down.

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { STOP_MESSAGE_PREFIX } from "../inventory.mjs";
import { sortedJson } from "./normalize.mjs";

// cline-tool-guard.mjs:10. Restated rather than imported because the guard's own output carries it:
// every recorded cancel reason begins with it, so a drift here shows up as a recorded diff.
export const CANCEL_PREFIX = "Cline editing guard: ";

// cline-cli-worker.mjs:564. Taken from the inventory, which asserts the literal against the
// worker's source — nothing a recording contains can prove this format on its own.
export const stopMessage = (reason) => `${STOP_MESSAGE_PREFIX}${reason}`;

/** Snapshot the whole generated <stateDir>/cline-guard/ tree as normalized text, raw byte order. */
export async function snapshotTree(root, normalizer, destination) {
  const walk = async (directory, relative) => {
    for (const item of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, item.name);
      const next = relative ? `${relative}/${item.name}` : item.name;
      if (item.isDirectory()) { await walk(absolute, next); continue; }
      if (next.endsWith(".lock")) continue;
      const target = path.join(destination, next);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, normalizer.text(await readFile(absolute, "utf8")), "utf8");
    }
  };
  await mkdir(destination, { recursive: true });
  await walk(root, "");
}

/**
 * A policy snapshot for the record: keys sorted so only genuine value drift shows here, while the
 * raw key order still has to match in artifacts/policy.json.
 */
export function snapshotForRecord(snapshot, normalizer) {
  if (snapshot.missing) return { missing: true };
  if (snapshot.raw !== undefined) return { raw: normalizer.pathsOnly(snapshot.raw) };
  return { json: JSON.parse(sortedJson(normalizer.valuePaths(snapshot.json))) };
}

/**
 * Every reason string a recorded control carries. A hook subprocess's stderr is deliberately not
 * read: it carries the engine's own STATE_WRITTEN diagnostics, not guard reasons. The Codex rail,
 * whose reason channel *is* stderr, builds its strings.json directly in capture.mjs.
 */
export function reasonsOf(control) {
  const found = [];
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (typeof node.reason === "string") found.push(node.reason);
    if (typeof node.errorMessage === "string") found.push(node.errorMessage);
    if (typeof node.message === "string") found.push(node.message);
    if (typeof node.stdout === "string" && node.stdout.trim()) {
      try { visit(JSON.parse(node.stdout)); } catch { found.push(node.stdout); }
    }
    for (const value of Object.values(node)) if (value && typeof value === "object") visit(value);
  };
  visit(control);
  return found;
}

/**
 * The worker- and loop-visible strings for one case: the guard outcome cline-cli-worker.mjs:561
 * reads, the capabilities blocked-resolver.mjs:68 reads, and — for every reason the case produced
 * — the composed worker error from :564 plus canRecoverOperational's verdict on it.
 */
export async function deriveStrings({ guard, prepared, stateDir, events, normalizer, canRecoverOperational }) {
  const outcome = await guard.readGuardOutcome(prepared.policyPath)
    .then((value) => ({ returned: value }), (error) => ({ threw: error.message }));
  const capabilities = await guard.readWorkerCapabilities(stateDir)
    .then((value) => ({ returned: value }), (error) => ({ threw: error.message }));

  const seen = [];
  for (const event of events) for (const reason of reasonsOf(event.control)) if (!seen.includes(reason)) seen.push(reason);

  const reasons = seen.map((raw) => {
    const reason = raw.startsWith(CANCEL_PREFIX) ? raw.slice(CANCEL_PREFIX.length) : raw;
    const message = stopMessage(reason);
    return {
      raw: normalizer.text(raw),
      reason: normalizer.text(reason),
      hadCancelPrefix: raw.startsWith(CANCEL_PREFIX),
      stopMessage: normalizer.text(message),
      cancelMessage: normalizer.text(CANCEL_PREFIX + reason),
      canRecoverOperational: canRecoverOperational({
        headMatches: true, unexpectedPaths: [], currentDiff: { truncated: false },
        failure: { reason: message, cause: null },
      }),
    };
  });

  return {
    guardOutcome: outcome.returned
      ? JSON.parse(sortedJson(normalizer.valuePaths(outcome.returned)))
      : { threw: normalizer.text(outcome.threw) },
    // Both policy views are key-sorted for the same reason the recorded snapshots are: replay's
    // isolated mode restores policy.json from a recorded (sorted) snapshot, so natural key order
    // cannot survive it. Raw key order is gated instead by artifacts/policy.json, which is the
    // prepared policy as the guard actually wrote it.
    workerCapabilities: capabilities.returned !== undefined && capabilities.returned !== null
      ? JSON.parse(sortedJson(normalizer.valuePaths(capabilities.returned)))
      : capabilities.returned === null ? null : { threw: normalizer.text(capabilities.threw) },
    reasons,
  };
}
