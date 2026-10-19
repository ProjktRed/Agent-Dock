import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { renameWithRetry, replaceWithRetry } from "../src/fs-retry.mjs";

const locked = (times, code = "EPERM") => {
  let calls = 0;
  return { impl: async () => { calls++; if (calls <= times) throw Object.assign(new Error(code), { code }); }, calls: () => calls };
};

test("a rename blocked for a moment by another process succeeds on a later attempt", async () => {
  const lock = locked(4);
  const waits = [];
  await renameWithRetry("a", "b", { renameImpl: lock.impl, sleep: async (ms) => { waits.push(ms); } });
  assert.equal(lock.calls(), 5);
  assert.deepEqual(waits, [10, 20, 40, 80]);
});

test("a lock that outlasts the budget, or any other error, is reported", async () => {
  const lock = locked(Infinity, "EBUSY");
  await assert.rejects(renameWithRetry("a", "b", { renameImpl: lock.impl, sleep: async () => {}, budgetMs: 1_000 }), { code: "EBUSY" });
  assert.ok(lock.calls() > 4 && lock.calls() < 12);
  const missing = locked(Infinity, "ENOENT");
  await assert.rejects(renameWithRetry("a", "b", { renameImpl: missing.impl, sleep: async () => {} }), { code: "ENOENT" });
  assert.equal(missing.calls(), 1);
});

test("a failed replacement leaves no temporary file behind", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fs-retry-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const temporary = path.join(dir, "state.json.tmp"), file = path.join(dir, "state.json");
  await writeFile(temporary, "new");
  await replaceWithRetry(temporary, file);
  assert.equal(await readFile(file, "utf8"), "new");
  await writeFile(temporary, "newer");
  const lock = locked(Infinity);
  await assert.rejects(replaceWithRetry(temporary, file, { renameImpl: lock.impl, sleep: async () => {}, budgetMs: 50 }));
  assert.equal(existsSync(temporary), false);
  assert.equal(await readFile(file, "utf8"), "new");
});
