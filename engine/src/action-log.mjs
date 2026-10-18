import { createHash } from "node:crypto";
import { appendFile, mkdir, open, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Append-only action log: every activity event and control request, each entry chained to the one
// before by a SHA-256 hash. Editing or deleting an entry breaks the chain from that point, which
// verifyActionLog reports. Unlike activity.ndjson, nothing in Agent Dock ever clears or rewrites it.
export const ACTION_LOG = "action-log.ndjson";
export const GENESIS = "0".repeat(64);
const MAX_TEXT = 2000;
const queues = new Map();

/** JSON with sorted keys, so the hash does not depend on property order. */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value ?? null);
}

const entryHash = (entry) => createHash("sha256").update(canonical(entry)).digest("hex");

/** Long texts (QA output, stack traces) are cut; the log records what happened, not every byte. */
function compact(event) {
  return JSON.parse(JSON.stringify(event ?? {}, (_key, value) => (typeof value === "string" && value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}…[${value.length - MAX_TEXT} more]` : value)));
}

async function lastEntry(file) {
  let handle;
  try { handle = await open(file, "r"); } catch (error) { if (error.code === "ENOENT") return { seq: 0, hash: GENESIS }; throw error; }
  try {
    const { size } = await handle.stat();
    if (!size) return { seq: 0, hash: GENESIS };
    const length = Math.min(size, 256 * 1024), buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const line = buffer.toString("utf8").trimEnd().split("\n").at(-1);
    const entry = JSON.parse(line);
    if (!Number.isInteger(entry.seq) || typeof entry.hash !== "string") throw new Error("last entry has no seq/hash");
    return entry;
  } finally { await handle.close(); }
}

/** One writer at a time across processes (engine, app, dashboard, stop-all CLI). */
async function withLock(file, operation) {
  const lock = `${file}.lock`;
  for (let attempt = 0;; attempt++) {
    try {
      const handle = await open(lock, "wx");
      try { return await operation(); } finally { await handle.close(); await rm(lock, { force: true }); }
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      // A writer that died mid-append leaves its lock; appends take milliseconds.
      const age = await stat(lock).then((s) => Date.now() - s.mtimeMs, () => 0);
      if (age > 10_000) await rm(lock, { force: true });
      else if (attempt > 500) throw new Error("Action log is locked by another writer");
      else await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

/** Appends one entry: {...event, seq, at, prev, hash}. The log's own fields always win over the event's. */
export function appendAction(stateDir, event) {
  const file = path.join(path.resolve(stateDir), ACTION_LOG);
  const previous = queues.get(file) ?? Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    await mkdir(path.dirname(file), { recursive: true });
    return withLock(file, async () => {
      const last = await lastEntry(file);
      const { hash: _ignored, ...fields } = compact(event);
      const entry = { ...fields, seq: last.seq + 1, at: new Date().toISOString(), prev: last.hash };
      entry.hash = entryHash(entry);
      await appendFile(file, `${JSON.stringify(entry)}\n`);
      return entry;
    });
  });
  queues.set(file, operation);
  return operation.finally(() => { if (queues.get(file) === operation) queues.delete(file); });
}

/** Waits for every queued append (call before the process exits). */
export async function flushActionLog() {
  await Promise.allSettled([...queues.values()]);
}

/** Checks every entry's sequence, link and hash. ok=false names the first entry that does not fit. */
export async function verifyActionLog(stateDir) {
  let text;
  try { text = await readFile(path.join(path.resolve(stateDir), ACTION_LOG), "utf8"); }
  catch (error) { if (error.code === "ENOENT") return { ok: true, entries: 0, head: GENESIS, lastAt: null }; throw error; }
  const lines = text.split("\n").filter((line) => line.trim());
  let prev = GENESIS, seq = 0, lastAt = null;
  for (const [index, line] of lines.entries()) {
    const fail = (reason) => ({ ok: false, entries: lines.length, head: prev, lastAt, brokenAt: index + 1, reason });
    let entry;
    try { entry = JSON.parse(line); } catch { return fail("not valid JSON"); }
    const { hash, ...rest } = entry;
    if (entry.seq !== seq + 1) return fail(`sequence jumps from ${seq} to ${entry.seq}`);
    if (entry.prev !== prev) return fail("does not link to the entry before it");
    if (hash !== entryHash(rest)) return fail("content changed after it was written");
    prev = hash; seq = entry.seq; lastAt = entry.at;
  }
  return { ok: true, entries: lines.length, head: prev, lastAt };
}

// node engine/src/action-log.mjs <state folder>: verify one project's log from a terminal.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await verifyActionLog(process.argv[2] ?? ".");
  console.log(result.ok ? `Action log verified: ${result.entries} entries, head ${result.head}` : `Action log NOT verified at entry ${result.brokenAt}: ${result.reason}`);
  process.exitCode = result.ok ? 0 : 1;
}
