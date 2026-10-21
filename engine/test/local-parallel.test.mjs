import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { prepareClineRuntime } from "../src/cline-runtime-config.mjs";
import { llamaCppSlots, localLanes } from "../src/local-parallel.mjs";
import { childArgs } from "../src/parallel-run.mjs";

const okJson = (value) => ({ ok: true, status: 200, json: async () => value });

test("a round on llama.cpp has at most as many tasks as the server has slots", async () => {
  const seen = [];
  const server = (slots) => async (url) => { seen.push(url); return url.includes("/props") ? okJson(slots === null ? {} : { total_slots: slots }) : okJson({}); };
  assert.equal(await llamaCppSlots(server(4), "http://127.0.0.1:8080/v1"), 4);
  assert.equal(seen.at(-1), "http://127.0.0.1:8080/props");
  await llamaCppSlots(server(2), "http://127.0.0.1:9000/v1", "qwen 3");
  assert.equal(seen.at(-1), "http://127.0.0.1:9000/props?model=qwen%203");
  assert.deepEqual(await localLanes({ provider: "llamacpp", lanes: 3, options: {}, fetchImpl: server(4) }), { lanes: 3, reason: null });
  const two = await localLanes({ provider: "llamacpp", lanes: 3, options: {}, fetchImpl: server(2) });
  assert.equal(two.lanes, 2);
  assert.match(two.reason, /2 slots \(llama-server --parallel\)/);
  assert.equal((await localLanes({ provider: "llamacpp", lanes: 3, options: {}, fetchImpl: server(null) })).lanes, 1);
  assert.equal((await localLanes({ provider: "llamacpp", lanes: 3, options: {}, fetchImpl: async () => { throw new Error("down"); } })).lanes, 1);
});

test("on Ollama it follows the requests at once you set, and cloud providers keep their lanes", async () => {
  assert.deepEqual(await localLanes({ provider: "ollama", lanes: 3, options: { "ollama-parallel": "4" } }), { lanes: 3, reason: null });
  const capped = await localLanes({ provider: "ollama", lanes: 3, options: {} });
  assert.equal(capped.lanes, 1);
  assert.match(capped.reason, /OLLAMA_NUM_PARALLEL/);
  assert.deepEqual(await localLanes({ provider: "openrouter", lanes: 3, options: {} }), { lanes: 3, reason: null });
  assert.deepEqual(await localLanes({ provider: "llamacpp", lanes: 1, options: {} }), { lanes: 1, reason: null });
});

test("task engines use the running llama.cpp server and never start one", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "llamacpp-external-"));
  let starts = 0;
  const down = async () => { const error = new Error("fetch failed"); error.cause = { code: "ECONNREFUSED" }; throw error; };
  await assert.rejects(prepareClineRuntime({ stateDir, provider: "llamacpp", model: "m", contextTokens: 8192, timeoutSeconds: 60, fetchImpl: down, llamaCppModelsDir: "/models", findServerImpl: () => "llama-server", startServerImpl: async () => { starts += 1; }, externalServer: true }), /never starts one itself/);
  assert.equal(starts, 0);
  const args = childArgs(["--objective", "B", "--local-server-managed", "app"], { worktree: "W", stateDir: "S", taskFile: "T" });
  assert.deepEqual(args.slice(-4), ["--local-server-managed", "external", "--parallel-child", "true"]);
  assert.equal(args.filter((a) => a === "--local-server-managed").length, 1);
});
