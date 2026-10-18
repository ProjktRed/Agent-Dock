import { readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { ACTION_LOG, pruneActionLog, rotateActionLog } from "./action-log.mjs";

// Retention (0.21.1). A project's state folder grows with every model call: per-call folders
// (prompt, events, result), Cline sessions, Activity and the action log. At each engine start,
// anything older than the retention period goes, but the newest folders always stay (they are what
// a crash or a question about the last run needs). 0 days keeps everything.
export const RETENTION_DEFAULTS = { days: 30, keepCalls: 100, keepSessions: 20, maxActivityBytes: 20 * 1024 * 1024, keepActivityLines: 5000, maxActionLogBytes: 20 * 1024 * 1024 };
const CALL_DIRS = ["codex", path.join("supervisor-review", "codex")];

async function pruneFolders(dir, { keep, cutoff }) {
  let names = [];
  try { names = await readdir(dir, { withFileTypes: true }); } catch { return 0; }
  const entries = [];
  for (const entry of names) {
    if (!entry.isDirectory()) continue;
    const full = path.join(dir, entry.name);
    entries.push({ full, mtime: await stat(full).then((s) => s.mtimeMs, () => Date.now()) });
  }
  entries.sort((a, b) => b.mtime - a.mtime);
  let removed = 0;
  for (const entry of entries.slice(keep)) {
    if (entry.mtime >= cutoff) continue;
    await rm(entry.full, { recursive: true, force: true }).then(() => removed++, () => {});
  }
  return removed;
}

/** Keeps the newest lines of a log that only the app reads (Activity); written in place of the old file. */
async function trimLines(file, { maxBytes, keepLines }) {
  const size = await stat(file).then((s) => s.size, () => 0);
  if (size <= maxBytes) return false;
  const lines = (await readFile(file, "utf8")).split("\n").filter(Boolean);
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${lines.slice(-keepLines).join("\n")}\n`);
  await rename(temp, file);
  return true;
}

export async function applyRetention(stateDir, options = {}) {
  const o = { ...RETENTION_DEFAULTS, ...options };
  const summary = { calls: 0, sessions: 0, setAside: 0, activityTrimmed: false, actionLogRotated: false, actionLogPruned: 0 };
  if (!(o.days > 0)) return summary;
  const cutoff = (o.now ?? Date.now()) - o.days * 24 * 60 * 60 * 1000;
  for (const dir of CALL_DIRS) summary.calls += await pruneFolders(path.join(stateDir, dir), { keep: o.keepCalls, cutoff });
  summary.sessions = await pruneFolders(path.join(stateDir, "cline-data", "sessions"), { keep: o.keepSessions, cutoff });
  try {
    for (const name of await readdir(path.join(stateDir, "set-aside"))) {
      const full = path.join(stateDir, "set-aside", name);
      if ((await stat(full)).mtimeMs < cutoff) { await rm(full, { force: true }); summary.setAside++; }
    }
  } catch {}
  summary.activityTrimmed = await trimLines(path.join(stateDir, "activity.ndjson"), { maxBytes: o.maxActivityBytes, keepLines: o.keepActivityLines }).catch(() => false);
  summary.actionLogRotated = await rotateActionLog(stateDir, { maxBytes: o.maxActionLogBytes }).catch(() => false);
  summary.actionLogPruned = await pruneActionLog(stateDir, { before: cutoff }).catch(() => 0);
  return summary;
}

export { ACTION_LOG };
