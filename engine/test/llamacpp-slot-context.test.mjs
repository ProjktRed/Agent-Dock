import assert from "node:assert/strict";
import test from "node:test";
import { readLlamaCppSlotContext } from "../src/cline-runtime-config.mjs";

const fetchWith = (body, ok = true) => async (url) => {
  assert.equal(url, "http://127.0.0.1:8081/props");
  return { ok, json: async () => body };
};

test("reads the slot context from llama-server /props", async () => {
  assert.equal(await readLlamaCppSlotContext(fetchWith({ default_generation_settings: { n_ctx: 98304 } }), "http://127.0.0.1:8081/v1"), 98304);
});

test("returns null when /props is unavailable or silent, so preflight never fails on missing data", async () => {
  assert.equal(await readLlamaCppSlotContext(fetchWith({}, false), "http://127.0.0.1:8081/v1"), null);
  assert.equal(await readLlamaCppSlotContext(fetchWith({ default_generation_settings: {} }), "http://127.0.0.1:8081/v1"), null);
  assert.equal(await readLlamaCppSlotContext(async () => { throw new Error("down"); }, "http://127.0.0.1:8081/v1"), null);
});
