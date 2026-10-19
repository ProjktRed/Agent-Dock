import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { findLlamaServer, llamaCppLauncherArgs, llamaServerArgs, prepareClineRuntime } from "../src/cline-runtime-config.mjs";
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
    assert.ok(requests.includes("http://127.0.0.1:8080/props?model=GLM"));
    assert.equal((await runtime.readMetrics()).promptTokens, 10);
    assert.ok(requests.includes("http://127.0.0.1:8080/metrics?model=GLM"));
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("without a launcher script, llama-server from PATH serves the models folder on the connection's port", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "llama-direct-"));
  const starts = [];
  let up = false;
  try {
    await prepareClineRuntime({
      stateDir, provider: "llamacpp", model: "Qwen", contextTokens: 32_768, timeoutSeconds: 60,
      llamaCppUrl: "http://127.0.0.1:9123/v1", llamaCppModelsDir: "D:\\models", llamaCppLauncher: null,
      findServerImpl: () => "C:\\llama\\llama-server.exe",
      fetchImpl: async (url) => {
        if (url.endsWith("/health")) { if (!up) throw new Error("connection refused"); return okJson({ status: "ok" }); }
        if (url.endsWith("/v1/models")) return okJson({ data: [{ id: "Qwen" }] });
        if (url.includes("/props")) return okJson({ default_generation_settings: { n_ctx: 32_768 } });
        throw new Error(`unexpected URL ${url}`);
      },
      startServerImpl: async (command, args, options) => { starts.push({ command, args, options }); up = true; },
      sleepImpl: async () => {},
    });
    assert.deepEqual(starts, [{ command: "C:\\llama\\llama-server.exe", args: ["--models-dir", "D:\\models", "--host", "127.0.0.1", "--port", "9123", "--metrics", "--ctx-size", "32768"], options: { direct: true } }]);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("llama.cpp that is not running, with no models folder or launcher, says how to start it", async () => {
  await assert.rejects(prepareClineRuntime({
    stateDir: os.tmpdir(), provider: "llamacpp", model: "Qwen", contextTokens: 8_192, timeoutSeconds: 60, llamaCppLauncher: null,
    findServerImpl: () => "C:\\llama\\llama-server.exe",
    fetchImpl: async () => { throw new Error("connection refused"); },
    startServerImpl: async () => assert.fail("must not start without a models folder"),
  }), /models folder .*launcher script/);
});

test("llama-server is found on PATH and its direct arguments carry thinking", () => {
  const dirs = ["C:\\tools", "C:\\llama"].join(path.delimiter);
  const exe = process.platform === "win32" ? "llama-server.exe" : "llama-server";
  assert.equal(findLlamaServer({ PATH: dirs }, process.platform, (p) => p === path.join("C:\\llama", exe)), path.join("C:\\llama", exe));
  assert.equal(findLlamaServer({ PATH: dirs }, process.platform, () => false), null);
  assert.deepEqual(llamaServerArgs({ baseUrl: "http://localhost:8080/v1", modelsDir: "m", thinking: "high" }), ["--models-dir", "m", "--host", "localhost", "--port", "8080", "--metrics", "--reasoning", "on", "--reasoning-effort", "high"]);
});
