import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { llamaCppLauncherArgs, prepareClineRuntime } from "../src/cline-runtime-config.mjs";
import { buildClineArgs } from "../src/cline-cli-worker.mjs";
import { parseLoopOptions } from "../src/loop-options.mjs";

const okJson = (value) => ({ ok: true, status: 200, json: async () => value, text: async () => "" });

test("thinking and models-folder flags parse; thinking defaults to none", () => {
  const defaults = parseLoopOptions(["--workspace", "w", "--objective", "o"]);
  assert.equal(defaults.clineThinking, "none");
  assert.equal(defaults.llamacppModelsDir, null);
  const set = parseLoopOptions(["--workspace", "w", "--objective", "o", "--cline-thinking", "high", "--llamacpp-models-dir", "D:\\models"]);
  assert.equal(set.clineThinking, "high");
  assert.equal(set.llamacppModelsDir, "D:\\models");
  assert.throws(() => parseLoopOptions(["--workspace", "w", "--objective", "o", "--cline-thinking", "ultra"]), /cline-thinking must be one of/);
});

test("Cline gets the configured thinking level", () => {
  const args = (thinking) => buildClineArgs({ clineJs: "cline", workspace: "repo", provider: "ollama", model: "m", timeoutSeconds: 60, prompt: "p", ...(thinking ? { thinking } : {}) });
  assert.equal(args()[args().indexOf("--thinking") + 1], "none");
  assert.equal(args("medium")[args("medium").indexOf("--thinking") + 1], "medium");
});

test("launcher args: router mode over a folder, reasoning only when thinking is on", () => {
  assert.deepEqual(llamaCppLauncherArgs(), []);
  assert.deepEqual(llamaCppLauncherArgs({ modelsDir: "D:\\models" }), ["-ModelsDir", "D:\\models"]);
  assert.deepEqual(llamaCppLauncherArgs({ modelsDir: "D", thinking: "high" }), ["-ModelsDir", "D", "-Reasoning", "on", "-ReasoningEffort", "high"]);
});

test("router mode starts the launcher with the folder and reads /props and /metrics for the chosen model", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "llamacpp-router-"));
  const requests = [];
  const starts = [];
  let up = false;
  try {
    const runtime = await prepareClineRuntime({
      stateDir,
      provider: "llamacpp",
      model: "GLM",
      contextTokens: 24_576,
      timeoutSeconds: 60,
      llamaCppModelsDir: "D:\\models",
      llamaCppLauncher: "C:\\llama\\start-server.cmd",
      thinking: "low",
      fetchImpl: async (url) => {
        requests.push(url);
        if (url.endsWith("/health")) {
          if (!up) throw new Error("connection refused");
          return okJson({ status: "ok" });
        }
        if (url.endsWith("/v1/models")) return okJson({ data: [{ id: "GLM" }, { id: "Qwen" }] });
        if (url.includes("/props")) return okJson({ default_generation_settings: { n_ctx: 98_304 } });
        if (url.includes("/metrics")) return { ok: true, status: 200, text: async () => "llamacpp:prompt_tokens_total 10\n" };
        throw new Error(`unexpected URL ${url}`);
      },
      startServerImpl: async (launcher, args) => {
        starts.push(args);
        up = true;
      },
      sleepImpl: async () => {},
    });
    assert.deepEqual(starts, [["-ModelsDir", "D:\\models", "-Reasoning", "on", "-ReasoningEffort", "low"]]);
    assert.ok(requests.includes("http://127.0.0.1:8081/props?model=GLM"));
    assert.equal((await runtime.readMetrics()).promptTokens, 10);
    assert.ok(requests.includes("http://127.0.0.1:8081/metrics?model=GLM"));
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
