import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { launchCline } from "../src/cline-cli-worker.mjs";

// A stand-in for Cline that records the environment it was started with (its last argument is the prompt,
// used here as the output file) and exits.
const RECORDER = `require("node:fs").writeFileSync(process.argv.at(-1), JSON.stringify(process.env));`;

test("Cline gets only the provider variable it is launched with, never another key from the environment", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cline-env-"));
  const unrelated = { OPENROUTER_API_KEY: "sk-or-unrelated", OPENAI_API_KEY: "sk-openai-unrelated", OPENCODE_API_KEY: "oc-unrelated",
    OPENCODE_SERVER_PASSWORD: "oc-pass", GEMINI_API_KEY: "gem-unrelated", XAI_API_KEY: "xai-unrelated", DEEPSEEK_API_KEY: "ds-unrelated", GITHUB_TOKEN: "gh-unrelated" };
  const prior = Object.fromEntries(Object.keys(unrelated).map((name) => [name, process.env[name]]));
  t.after(async () => {
    for (const [name, value] of Object.entries(prior)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
    await rm(root, { recursive: true, force: true });
  });
  const clineJs = path.join(root, "fake-cline.cjs");
  await writeFile(clineJs, RECORDER);
  Object.assign(process.env, unrelated);
  const keys = (seen) => Object.fromEntries(Object.keys(unrelated).map((name) => [name, seen[name] ?? null]));
  const none = Object.fromEntries(Object.keys(unrelated).map((name) => [name, null]));

  const run = async (launchEnv) => {
    const out = path.join(root, `seen-${Math.random().toString(36).slice(2)}.json`);
    await launchCline({ clineJs, workspace: root, model: "m", timeoutSeconds: 30, prompt: out, ...(launchEnv ? { launchEnv } : {}) }).catch(() => {});
    return JSON.parse(await readFile(out, "utf8"));
  };

  // Provider openai: the broker's token in OPENAI_API_KEY, and the unrelated OpenRouter key is gone.
  const withBroker = await run({ OPENAI_API_KEY: "broker-token" });
  assert.deepEqual(keys(withBroker), { ...none, OPENAI_API_KEY: "broker-token" });
  assert.ok(withBroker.PATH ?? withBroker.Path, "ordinary variables still reach Cline");
  // A local provider (Ollama): no provider key at all.
  assert.deepEqual(keys(await run(null)), none);
});
