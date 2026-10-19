import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { prepareClineRuntime } from "../src/cline-runtime-config.mjs";

const okJson = (value) => ({ ok: true, status: 200, json: async () => value });

test("healthy llama.cpp writes an isolated OpenAI-compatible Cline profile", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "llamacpp-ready-"));
  const requests = [];
  let starts = 0;
  try {
    const runtime = await prepareClineRuntime({
      stateDir,
      provider: "llamacpp",
      model: "glm-4.7-flash-ud-q3-k-xl",
      contextTokens: 24_576,
      maxOutputTokens: 4_096,
      timeoutSeconds: 1_800,
      fetchImpl: async (url) => {
        requests.push(url);
        if (url.endsWith("/health")) return okJson({ status: "ok" });
        if (url.endsWith("/v1/models")) return okJson({ data: [{ id: "glm-4.7-flash-ud-q3-k-xl" }] });
        throw new Error(`unexpected URL ${url}`);
      },
      startServerImpl: async () => { starts += 1; },
    });

    assert.equal(starts, 0);
    // /props is the slot-context check; this fake server does not report it, so it is skipped.
    assert.deepEqual(requests, ["http://127.0.0.1:8080/health", "http://127.0.0.1:8080/v1/models", "http://127.0.0.1:8080/props"]);
    assert.equal(runtime.requestedProvider, "llamacpp");
    assert.equal(runtime.provider, "openai-compatible");
    assert.equal(runtime.baseUrl, "http://127.0.0.1:8080/v1");
    assert.equal(runtime.model, "glm-4.7-flash-ud-q3-k-xl");

    const stored = JSON.parse(await readFile(path.join(runtime.dataDir, "settings", "providers.json"), "utf8"));
    assert.equal(stored.lastUsedProvider, "openai-compatible");
    assert.deepEqual(stored.providers["openai-compatible"].settings, {
      provider: "openai-compatible",
      client: "openai-compatible",
      protocol: "openai-chat",
      apiKey: "local-no-key",
      model: "glm-4.7-flash-ud-q3-k-xl",
      baseUrl: "http://127.0.0.1:8080/v1",
      contextWindow: 24_576,
      maxTokens: 4_096,
      timeout: 1_800_000,
      capabilities: ["tools", "streaming"],
    });
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

test("unavailable llama.cpp starts the approved launcher and waits for model discovery", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "llamacpp-start-"));
  let healthAttempts = 0;
  const starts = [];
  try {
    const runtime = await prepareClineRuntime({
      stateDir,
      provider: "llamacpp",
      model: "glm-4.7-flash-ud-q3-k-xl",
      contextTokens: 24_576,
      maxOutputTokens: 4_096,
      timeoutSeconds: 1_800,
      startupAttempts: 3,
      sleepImpl: async () => {},
      fetchImpl: async (url) => {
        if (url.endsWith("/health")) {
          healthAttempts += 1;
          if (healthAttempts < 3) throw new Error("connect ECONNREFUSED");
          return okJson({ status: "ok" });
        }
        return okJson({ data: [{ id: "glm-4.7-flash-ud-q3-k-xl" }] });
      },
      llamaCppLauncher: "C:\\llama\\start-server.cmd",
      startServerImpl: async (launcher) => { starts.push(launcher); },
    });

    assert.deepEqual(starts, ["C:\\llama\\start-server.cmd"]);
    assert.equal(healthAttempts, 3);
    assert.equal(runtime.startedServer, true);
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

test("llama.cpp model mismatch fails instead of falling back to Ollama", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "llamacpp-model-"));
  try {
    await assert.rejects(prepareClineRuntime({
      stateDir,
      provider: "llamacpp",
      model: "glm-4.7-flash-ud-q3-k-xl",
      contextTokens: 24_576,
      maxOutputTokens: 4_096,
      timeoutSeconds: 1_800,
      fetchImpl: async (url) => url.endsWith("/health")
        ? okJson({ status: "ok" })
        : okJson({ data: [{ id: "different-model" }] }),
      startServerImpl: async () => { throw new Error("must not start a healthy server"); },
    }), /does not advertise.*glm-4\.7-flash-ud-q3-k-xl/i);
    await assert.rejects(readFile(path.join(stateDir, "cline-data", "settings", "providers.json"), "utf8"), /ENOENT/);
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

test("refuses a llama.cpp server whose slot context is smaller than the requested Cline context", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "llamacpp-ctx-"));
  try {
    await assert.rejects(prepareClineRuntime({
      stateDir, provider: "llamacpp", model: "glm-4.7-flash-ud-q3-k-xl",
      contextTokens: 98_304, maxOutputTokens: 8_192, timeoutSeconds: 1_800,
      fetchImpl: async (url) => {
        if (url.endsWith("/health")) return okJson({ status: "ok" });
        if (url.endsWith("/v1/models")) return okJson({ data: [{ id: "glm-4.7-flash-ud-q3-k-xl" }] });
        if (url.endsWith("/props")) return okJson({ default_generation_settings: { n_ctx: 32_768 } });
        throw new Error(`unexpected URL ${url}`);
      },
      startServerImpl: async () => {},
    }), /slot context is 32768 tokens, below the requested 98304/);
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});
