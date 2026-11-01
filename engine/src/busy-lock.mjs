import { randomUUID } from "node:crypto";
import { open, readFile, rm, stat } from "node:fs/promises";

// One implementation at a time per state folder: the Cline, OpenCode and Codex/Claude Code workers share
// cline.busy.lock. Creating the file (open "wx") is the acquisition; its contents name the owner as
// "<pid> <token>". A lock is stale only when its process has ended, or when it is still empty a while
// after it was made (its creator died before writing): a fresh empty lock belongs to a worker that is
// writing its pid right now (Rev F11).
const EMPTY_GRACE_MS = 30_000;

const pidOf = (text) => Number(String(text).trim().split(/\s+/)[0]);

function running(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; }
}

/** Whether a live owner holds the lock; a stale one is removed (only if it is still the same lock). */
export async function lockHeld(lockPath, now = Date.now) {
  let text, info;
  try { [text, info] = await Promise.all([readFile(lockPath, "utf8"), stat(lockPath)]); }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
  const pid = pidOf(text);
  if (Number.isInteger(pid) && pid > 0 ? running(pid) : now() - info.mtimeMs < EMPTY_GRACE_MS) return true;
  // Removed only while it still holds what was judged stale, never a lock someone just took.
  if ((await readFile(lockPath, "utf8").catch(() => null)) === text) await rm(lockPath, { force: true });
  return false;
}

/** Runs operation while holding the lock, or returns null when another live worker holds it. */
export async function withBusyLock(lockPath, operation, { beforeOperation = async () => false } = {}) {
  let handle = null;
  for (let attempt = 0; attempt < 2 && !handle; attempt++) {
    try { handle = await open(lockPath, "wx"); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (await lockHeld(lockPath)) return null;
    }
  }
  if (!handle) return null;
  const owner = `${process.pid} ${randomUUID()}\n`;
  try {
    await handle.writeFile(owner);
    await handle.close();
    handle = null;
    if (await beforeOperation()) return null;
    return await operation();
  } finally {
    if (handle) await handle.close();
    // Only our own lock is removed.
    if ((await readFile(lockPath, "utf8").catch(() => null)) === owner) await rm(lockPath, { force: true });
  }
}
