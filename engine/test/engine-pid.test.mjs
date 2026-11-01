import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ENGINE_PID_FILE, writeEnginePid } from "../src/engine-pid.mjs";

test("the engine records its own pid, platform and start time for Stop now", async () => {
  const dir = path.join(await mkdtemp(path.join(os.tmpdir(), "engine-pid-")), "state");
  writeEnginePid(dir, new Date("2026-10-21T10:00:00Z"));
  assert.deepEqual(JSON.parse(await readFile(path.join(dir, ENGINE_PID_FILE), "utf8")), { pid: process.pid, platform: process.platform, startedAt: "2026-10-21T10:00:00.000Z" });
});
