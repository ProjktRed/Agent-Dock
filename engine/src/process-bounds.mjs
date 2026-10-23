import { spawn } from "node:child_process";

// Bounds for processes the engine waits on (Rev F12): a deadline that ends the whole process tree, and
// output kept to its newest part, so a check that never exits or never stops printing cannot hang the
// run or exhaust the engine's memory.

/** A project check (npm test and the like). */
export const CHECK_TIMEOUT_MS = 30 * 60_000;
/** One Codex orchestration call (Assessment, QA, Resolver, Elevation). */
export const CODEX_CALL_TIMEOUT_MS = 60 * 60_000;
/** Characters of output kept per stream. */
export const OUTPUT_LIMIT = 4 * 1024 * 1024;

/** text + chunk, cut to its last `limit` characters (with a note of what was cut). */
export function appendBounded(text, chunk, limit = OUTPUT_LIMIT) {
  const next = text + chunk;
  if (next.length <= limit) return next;
  const note = "[earlier output cut]\n";
  return note + next.slice(next.length - limit + note.length);
}

/**
 * Ends the process and everything it started. On POSIX: its own process group when it was spawned
 * detached; otherwise (it stays in the engine's group, so Stop now still reaches it) its children, then it.
 */
export function killProcessTree(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") { spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => {}); return; }
  try { process.kill(-child.pid, "SIGKILL"); return; } catch { /* not a group leader */ }
  spawn("pkill", ["-KILL", "-P", String(child.pid)], { stdio: "ignore" }).on("error", () => {});
  try { child.kill("SIGKILL"); } catch { /* already gone */ }
}
