import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { lockHeld, withBusyLock } from "../src/busy-lock.mjs";

// Rev F11: between creating the lock and writing its pid, another worker took the empty lock for stale.
test("a fresh empty lock is held; an old empty one or a dead owner's is stale; only the owner removes it", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "busy-lock-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const lock = path.join(dir, "cline.busy.lock");
  await writeFile(lock, "");
  assert.equal(await lockHeld(lock), true);
  assert.equal(await withBusyLock(lock, async () => "ran"), null);
  await utimes(lock, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  assert.equal(await lockHeld(lock), false);
  await writeFile(lock, "999999999 old\n");
  assert.equal(await withBusyLock(lock, async () => "ran"), "ran", "a dead owner's lock is taken over");
  // Two workers at once: exactly one runs, and the other's cleanup never removes the winner's lock.
  let inside = 0, most = 0;
  const work = () => withBusyLock(lock, async () => { inside++; most = Math.max(most, inside); await new Promise((r) => setTimeout(r, 50)); inside--; return "ran"; });
  const results = await Promise.all([work(), work(), work()]);
  assert.equal(results.filter((r) => r === "ran").length, 1);
  assert.equal(most, 1);
  await assert.rejects(readFile(lock), { code: "ENOENT" });
  await writeFile(lock, `${process.pid} someone-else\n`);
  assert.equal(await withBusyLock(lock, async () => "ran"), null);
  assert.equal(await readFile(lock, "utf8"), `${process.pid} someone-else\n`);
});
