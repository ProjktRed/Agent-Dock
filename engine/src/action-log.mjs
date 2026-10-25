import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { appendFile, mkdir, open, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { renameWithRetry as rename } from "./fs-retry.mjs";
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

// The hash chain alone can be recomputed by anyone who can write the file. With Agent Dock's log key
// (kept encrypted by the app, given to engines as AGENT_DOCK_LOG_KEY and never to the processes they
// start) each entry also carries mac = HMAC-SHA256(key, hash), which a rewrite cannot recompute.
let logKey = null;
/** The key as hex (64 characters), or null for none. */
export function useActionLogKey(hex) {
  logKey = typeof hex === "string" && /^[0-9a-f]{64}$/i.test(hex) ? Buffer.from(hex, "hex") : null;
}
useActionLogKey(process.env.AGENT_DOCK_LOG_KEY);
/** The key as hex, for a task engine this engine starts. */
export const actionLogKeyHex = () => logKey?.toString("hex") ?? null;
const entryMac = (key, hash) => createHmac("sha256", key).update(hash).digest("hex");
/** Entries written without the key on purpose: the terminal stop-all command (engine/src/stop-all.mjs). */
const keylessStop = (entry) => entry.source === "cli" && (entry.type === "stopped" || entry.type === "control-stop");

// Entries written before the key existed carry no signature. Which ones those are cannot come from the
// log itself (its times and order are as writable as the rest), so when the app makes the key it records
// each existing log's last entry here, signed: unsigned entries are accepted up to that one and no further.
export const LEGACY_CHECKPOINT = "action-log-legacy.json";
const checkpointMac = (key, seq, head, label = "legacy") => createHmac("sha256", key).update(`${label}:${seq}:${head}`).digest("hex");
async function signedRecord(file, key, label) {
  let saved;
  try { saved = JSON.parse(await readFile(file, "utf8")); } catch { return null; }
  if (!Number.isInteger(saved?.seq) || typeof saved.head !== "string" || typeof saved.mac !== "string") return null;
  const expected = Buffer.from(checkpointMac(key, saved.seq, saved.head, label)), got = Buffer.from(saved.mac);
  return expected.length === got.length && timingSafeEqual(expected, got) ? { seq: saved.seq, head: saved.head } : null;
}
const legacyCheckpoint = (dir, key) => signedRecord(path.join(dir, LEGACY_CHECKPOINT), key, "legacy");

// Removing the newest entries (or all of them) leaves a chain that still links. Every signed append also
// records the newest signed entry here, signed, so a log that ends before it or differs at it fails.
// Restoring an older copy of both files together is not detected.
export const HEAD_RECORD = "action-log-head.json";
const headRecord = (dir, key) => signedRecord(path.join(dir, HEAD_RECORD), key, "head");
async function writeHeadRecord(file, entry) {
  const target = path.join(path.dirname(file), HEAD_RECORD), temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify({ seq: entry.seq, head: entry.hash, mac: checkpointMac(logKey, entry.seq, entry.hash, "head") }));
  await rename(temp, target);
}

/**
 * Records, signed, where a log written without the key ends (the app calls this once, when it makes the
 * key). Does nothing for an empty log, one that already has signed entries or does not verify, or one
 * already recorded.
 */
export async function checkpointLegacyLog(stateDir) {
  if (!logKey) return false;
  const dir = path.resolve(stateDir), result = await verifyActionLog(dir, { key: null });
  if (!result.ok || !result.entries || result.macs) return false;
  const seq = result.lastSeq;
  try { await writeFile(path.join(dir, LEGACY_CHECKPOINT), JSON.stringify({ seq, head: result.head, mac: checkpointMac(logKey, seq, result.head) }), { flag: "wx" }); }
  catch (error) { if (error.code === "EEXIST") return false; throw error; }
  return true;
}

/** Long texts (QA output, stack traces) are cut; the log records what happened, not every byte. */
function compact(event) {
  return JSON.parse(JSON.stringify(event ?? {}, (_key, value) => (typeof value === "string" && value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}…[${value.length - MAX_TEXT} more]` : value)));
}

// Retention (0.21.1): a full log moves to action-log-<first>-<last>.ndjson and the chain continues
// in a new file; expired archives are deleted only after a chained "action-log-pruned" entry records
// where the remaining chain starts, so verification still covers everything that is left.
const ARCHIVE = /^action-log-(\d{9})-(\d{9})\.ndjson$/;
async function archives(dir) {
  let names = [];
  try { names = await readdir(dir); } catch { return []; }
  return names.map((name) => ({ name, match: name.match(ARCHIVE) })).filter((a) => a.match)
    .map((a) => ({ name: a.name, file: path.join(dir, a.name), first: Number(a.match[1]), last: Number(a.match[2]) })).sort((a, b) => a.first - b.first);
}
const pad = (n) => String(n).padStart(9, "0");

async function lastEntry(file) {
  const fromArchive = async () => { const newest = (await archives(path.dirname(file))).at(-1); return newest ? readLast(newest.file) : { seq: 0, hash: GENESIS }; };
  let handle;
  try { handle = await open(file, "r"); } catch (error) { if (error.code === "ENOENT") return fromArchive(); throw error; }
  try {
    const { size } = await handle.stat();
    if (!size) return fromArchive();
  } finally { await handle.close(); }
  return readLast(file);
}

async function readLast(file) {
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
      // Windows reports a lock another process is just deleting as EPERM, not EEXIST: it is busy too.
      if (error.code !== "EEXIST" && !(error.code === "EPERM" && process.platform === "win32")) throw error;
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
      if (logKey) entry.mac = entryMac(logKey, entry.hash);
      await appendFile(file, `${JSON.stringify(entry)}\n`);
      if (logKey) await writeHeadRecord(file, entry);
      return entry;
    });
  });
  queues.set(file, operation);
  return operation.finally(() => { if (queues.get(file) === operation) queues.delete(file); });
}

/** Moves a full log to an archive; the next append continues the chain from the archive's last entry. */
export async function rotateActionLog(stateDir, { maxBytes }) {
  const file = path.join(path.resolve(stateDir), ACTION_LOG);
  const size = await stat(file).then((s) => s.size, () => 0);
  if (!(maxBytes > 0) || size <= maxBytes) return false;
  await flushActionLog();
  return withLock(file, async () => {
    const text = await readFile(file, "utf8"), lines = text.split("\n").filter((l) => l.trim());
    if (!lines.length) return false;
    const first = JSON.parse(lines[0]).seq, last = JSON.parse(lines.at(-1)).seq;
    await rename(file, path.join(path.dirname(file), `action-log-${pad(first)}-${pad(last)}.ndjson`));
    return true;
  });
}

/** Deletes archives whose newest entry is older than `before`, oldest first, after recording where the chain now starts. */
export async function pruneActionLog(stateDir, { before }) {
  const dir = path.resolve(stateDir), list = await archives(dir), expired = [];
  for (const archive of list) {
    const last = await readLast(archive.file);
    if (Date.parse(last.at) < before) expired.push({ ...archive, head: last.hash }); else break;
  }
  if (!expired.length) return 0;
  const newest = expired.at(-1);
  await appendAction(stateDir, { type: "action-log-pruned", upToSeq: newest.last, head: newest.head, archives: expired.map((a) => a.name) });
  // Under the lock, so a verification never reads some of these archives and not others.
  await withLock(path.join(dir, ACTION_LOG), async () => { for (const archive of expired) await rm(archive.file, { force: true }); });
  return expired.length;
}

/** Waits for every queued append (call before the process exits). */
export async function flushActionLog() {
  await Promise.allSettled([...queues.values()]);
}

/**
 * Reads the archives, the log and its head record under the writers' lock: read without it, a verification
 * can land between an append and its head record (or a rotation or pruning) and report a sound log as
 * broken. A missing folder (nothing to verify) or a read-only one (no writer either) is read without it.
 */
async function readForVerify(dir, key) {
  const file = path.join(dir, ACTION_LOG);
  const read = async () => {
    const parts = [];
    for (const archive of await archives(dir)) parts.push(await readFile(archive.file, "utf8"));
    try { parts.push(await readFile(file, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    return { parts, anchor: key ? await headRecord(dir, key) : null };
  };
  try { return await withLock(file, read); }
  catch (error) { if (["ENOENT", "EACCES", "EROFS"].includes(error.code) || (error.code === "EPERM" && process.platform !== "win32")) return read(); throw error; }
}

/**
 * Checks every entry's sequence, link and hash, and with the log key its signature: every entry must be
 * signed except a terminal stop and those the signed legacy checkpoint covers. ok=false names the first
 * entry that does not fit.
 */
export async function verifyActionLog(stateDir, { key = logKey } = {}) {
  const dir = path.resolve(stateDir);
  const { parts, anchor } = await readForVerify(dir, key);
  const lines = parts.join("\n").split("\n").filter((line) => line.trim());
  if (!lines.length) return anchor ? { ok: false, entries: 0, head: GENESIS, lastAt: null, brokenAt: 0, reason: `the log is empty, but it had ${anchor.seq} entries` } : { ok: true, entries: 0, head: GENESIS, lastAt: null };
  let prev = GENESIS, seq = 0, lastAt = null, pruned = 0, signed = 0, macs = 0, unsigned = 0;
  const legacy = key ? await legacyCheckpoint(dir, key) : null;
  // Older archives were deleted by retention: the chain may start where a pruned record says it does.
  try {
    const first = JSON.parse(lines[0]);
    if (first.seq !== 1) {
      const marker = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((e) => e?.type === "action-log-pruned" && e.upToSeq === first.seq - 1 && e.head === first.prev);
      if (marker) { prev = marker.head; seq = marker.upToSeq; pruned = marker.upToSeq; }
    }
  } catch {}
  for (const [index, line] of lines.entries()) {
    const fail = (reason) => ({ ok: false, entries: lines.length, head: prev, lastAt, brokenAt: index + 1, reason });
    let entry;
    try { entry = JSON.parse(line); } catch { return fail("not valid JSON"); }
    const { hash, mac, ...rest } = entry;
    if (entry.seq !== seq + 1) return fail(`sequence jumps from ${seq} to ${entry.seq}`);
    if (entry.prev !== prev) return fail("does not link to the entry before it");
    if (hash !== entryHash(rest)) return fail("content changed after it was written");
    if (lastAt && Date.parse(entry.at) < Date.parse(lastAt)) return fail("its time is earlier than the entry before it");
    if (mac !== undefined) macs++;
    if (key && mac !== undefined) {
      const expected = Buffer.from(entryMac(key, String(hash))), got = Buffer.from(String(mac));
      if (expected.length !== got.length || !timingSafeEqual(expected, got)) return fail("its signature does not match Agent Dock's key");
      signed++;
    } else if (key && !keylessStop(entry) && !(legacy && !signed && entry.seq <= legacy.seq)) return fail("written without Agent Dock's key");
    else if (key) unsigned++;
    if (legacy && entry.seq === legacy.seq && hash !== legacy.head) return fail("differs from the log recorded when Agent Dock's key was made");
    if (anchor && entry.seq === anchor.seq && hash !== anchor.head) return fail("differs from the newest signed entry Agent Dock recorded");
    prev = hash; seq = entry.seq; lastAt = entry.at;
  }
  const short = (reason) => ({ ok: false, entries: lines.length, head: prev, lastAt, brokenAt: lines.length, reason });
  if (legacy && seq < legacy.seq) return short("entries recorded when Agent Dock's key was made are missing");
  if (anchor && seq < anchor.seq) return short(`the newest entries are missing (the log ends at ${seq}, it had ${anchor.seq})`);
  if (key && signed && !anchor) return short("the record of its newest signed entry is missing");
  return { ok: true, entries: lines.length, head: prev, lastAt, lastSeq: seq, ...(key ? { signed, unsigned } : { macs }), ...(pruned ? { pruned } : {}) };
}

// node engine/src/action-log.mjs <state folder>: verify one project's log from a terminal.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await verifyActionLog(process.argv[2] ?? ".");
  console.log(result.ok ? `Action log verified: ${result.entries} entries, head ${result.head}` : `Action log NOT verified at entry ${result.brokenAt}: ${result.reason}`);
  process.exitCode = result.ok ? 0 : 1;
}
