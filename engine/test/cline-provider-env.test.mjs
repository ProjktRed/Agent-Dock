import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { launchCline } from "../src/cline-cli-worker.mjs";

// A stand-in for Cline that records which provider keys it was started with (its last argument is the prompt,
// used here as the output file) and exits.
const RECORDER = `require("node:fs").writeFileSync(process.argv.at(-1), JSON.stringify({ openrouter: process.env.OPENROUTER_API_KEY ?? null, openai: process.env.OPENAI_API_KEY ?? null }));`;

test("Cline gets only the provider variable it is launched with, never another key from the environment", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cline-env-"));
  const prior = { OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY, OPENAI_API_KEY: process.env.OPENAI_API_KEY };
  t.after(async () => {
    for (const [name, value] of Object.entries(prior)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
    await rm(root, { recursive: true, force: true });
  });
  const clineJs = path.join(root, "fake-cline.cjs");
  await writeFile(clineJs, RECORDER);
  process.env.OPENROUTER_API_KEY = "sk-or-unrelated";
  process.env.OPENAI_API_KEY = "sk-openai-unrelated";

  const run = async (launchEnv) => {
    const out = path.join(root, `seen-${Math.random().toString(36).slice(2)}.json`);
    await launchCline({ clineJs, workspace: root, model: "m", timeoutSeconds: 30, prompt: out, ...(launchEnv ? { launchEnv } : {}) }).catch(() => {});
    return JSON.parse(await readFile(out, "utf8"));
  };

  // Provider openai: the broker's token in OPENAI_API_KEY, and the unrelated OpenRouter key is gone.
  assert.deepEqual(await run({ OPENAI_API_KEY: "broker-token" }), { openrouter: null, openai: "broker-token" });
  // A local provider (Ollama): no provider key at all.
  assert.deepEqual(await run(null), { openrouter: null, openai: null });
});
