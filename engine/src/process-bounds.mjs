import { spawn, spawnSync } from "node:child_process";

// Bounds for processes the engine waits on (Rev F12): a deadline that ends the whole process tree, and
// output kept to its newest part, so a check that never exits or never stops printing cannot hang the
// run or exhaust the engine's memory.

/** A project check (npm test and the like). */
export const CHECK_TIMEOUT_MS = 60 * 60_000;
/** One Codex orchestration call (Assessment, QA, Resolver, Elevation, at up to extra-high reasoning). */
export const CODEX_CALL_TIMEOUT_MS = 2 * 60 * 60_000;
/** Characters of output kept per stream. */
export const OUTPUT_LIMIT = 4 * 1024 * 1024;

/** text + chunk, cut to its last `limit` characters (with a note of what was cut). */
export function appendBounded(text, chunk, limit = OUTPUT_LIMIT) {
  const next = text + chunk;
  if (next.length <= limit) return next;
  const note = "[earlier output cut]\n";
  return note + next.slice(next.length - limit + note.length);
}

/** Every process below pid (POSIX), from one `ps` listing. */
function descendants(pid) {
  const listing = spawnSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" }).stdout ?? "";
  const children = new Map();
  for (const line of listing.split("\n")) {
    const [p, parent] = line.trim().split(/\s+/).map(Number);
    if (Number.isInteger(p) && Number.isInteger(parent)) children.set(parent, [...(children.get(parent) ?? []), p]);
  }
  const out = [];
  for (let queue = [pid]; queue.length;) for (const p of children.get(queue.pop()) ?? []) { out.push(p); queue.push(p); }
  return out;
}

/**
 * Ends the process and everything it started. The child stays in the engine's process group (so Stop now
 * still reaches it), so on POSIX its descendants are found and ended one by one.
 */
export function killProcessTree(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") { spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => {}); return; }
  for (const pid of [...descendants(child.pid).reverse(), child.pid]) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
}
