import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildClineArgs, ClineCliWorker, isAnyClineCliActive } from "../src/cline-cli-worker.mjs";

const fakeDoctor = path.resolve("fixtures/fake-cline-doctor.mjs");

test("doctor plain-text output remains valid for the external busy check", async () => {
  assert.equal(await isAnyClineCliActive(fakeDoctor), false);
});

test('missing CLI is an actionable error, not a busy worker',async()=>{
 await assert.rejects(isAnyClineCliActive(path.resolve('fixtures/nonexistent-cline-entry.mjs')),/Cline CLI unavailable.*nonexistent-cline-entry.*exit 1/is);
});

test('failed doctor preserves bounded failure evidence instead of reporting busy',async()=>{
 await assert.rejects(isAnyClineCliActive(path.resolve('fixtures/fake-cline-doctor-failure.mjs')),/Cline CLI unavailable.*exit 1.*fake broken Cline installation/is);
});

test('successful but unrecognized doctor output is a controlled diagnostic error',async()=>{
 await assert.rejects(isAnyClineCliActive(path.resolve('fixtures/fake-cline-doctor-invalid.mjs')),/Cannot determine Cline availability.*incomplete output/is);
});

test('valid busy report still queues work',async()=>{
 assert.equal(await isAnyClineCliActive(path.resolve('fixtures/fake-cline-doctor-busy.mjs')),true);
});

test('broken CLI prevents exclusive workflow execution rather than silently queuing',async()=>{
 const stateDir=await mkdtemp(path.join(os.tmpdir(),'cline-unavailable-'));
 try{
  const worker=new ClineCliWorker({stateDir,workspace:stateDir,clineJs:path.resolve('fixtures/fake-cline-doctor-failure.mjs')});
  await assert.rejects(worker.withExclusive(()=>assert.fail('must not progress workflow')),/Cline CLI unavailable/);
  await assert.rejects(readFile(path.join(stateDir,'cline.busy.lock'),'utf8'),/ENOENT/);
 }finally{await rm(stateDir,{recursive:true,force:true});}
});

test("headless JSON invocation includes the prompt argument", () => {
  const args = buildClineArgs({
    clineJs: "cline-js",
    workspace: "workspace",
    provider: "ollama",
    model: "glm-test",
    timeoutSeconds: 60,
    prompt: "Implement this task",
  });

  assert.equal(args.at(-1), "Implement this task");
  assert.deepEqual(args.slice(1, 9), [
    "--json",
    "--auto-approve",
    "true",
    "--compaction",
    "agentic",
    "--retries",
    "6",
    "--thinking",
  ]);
  assert.equal(args[9], "none");
  assert.equal(args.includes("--yolo"), false);
});

test("Cline defaults to 98K context and a 30 minute bounded timeout", () => {
  const worker = new ClineCliWorker({ stateDir: ".state", workspace: ".", checkExternalBusy: async () => false });

  assert.equal(worker.options.contextTokens, 98_304);
  assert.equal(worker.options.timeoutSeconds, 1_800);
});

test("Cline context and timeout overrides reach the isolated CLI invocation", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "cline-options-"));
  let launched;
  try {
    const worker = new ClineCliWorker({
      stateDir,
      workspace: stateDir,
      contextTokens: 65_536,
      timeoutSeconds: 900,
      dataDir: path.join(stateDir, "cline-data"),
      checkExternalBusy: async () => false,
      launch: async (options) => {
        launched = options;
        return { exitCode: 0, output: "done" };
      },
    });

    await worker.run("bounded task");
    assert.equal(launched.contextTokens, 65_536);
    assert.equal(launched.timeoutSeconds, 900);
    assert.equal(launched.dataDir, path.join(stateDir, "cline-data"));
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

test("without llama.cpp counters (Ollama), Cline's final usage counts toward budgets", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "cline-ollama-usage-"));
  try {
    const worker = new ClineCliWorker({
      stateDir, workspace: stateDir, provider: "ollama", model: "qwen", checkExternalBusy: async () => false,
      launch: async () => ({ exitCode: 0, output: "done", runResult: { finishReason: "completed", usage: { inputTokens: 900, outputTokens: 120, cacheReadTokens: 100, totalCost: 0 } } }),
    });
    const { RUN, clineUsage } = await import("../src/run-budget.mjs");
    const before = { ...RUN.usage };
    await worker.run("task", { onEvent: async () => {} });
    assert.deepEqual([RUN.usage.input - before.input, RUN.usage.cached - before.cached, RUN.usage.output - before.output], [1000, 100, 120]);
    assert.equal(clineUsage({ finishReason: "completed" }), null);
    assert.equal(clineUsage({ usage: { inputTokens: 1, outputTokens: 1 }, aggregateUsage: { inputTokens: 5, outputTokens: 2, totalCost: 0.25 } }).costUsd, 0.25);
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

test("llama.cpp readiness and metrics are checked around every Cline attempt", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "cline-llamacpp-attempt-"));
  const events = [];
  let readyChecks = 0;
  let metricReads = 0;
  try {
    const worker = new ClineCliWorker({
      stateDir,
      workspace: stateDir,
      provider: "openai-compatible",
      requestedProvider: "llamacpp",
      model: "glm-4.7-flash-ud-q3-k-xl",
      baseUrl: "http://127.0.0.1:8081/v1",
      checkExternalBusy: async () => false,
      beforeRun: async () => {
        readyChecks += 1;
        return { requestedProvider: "llamacpp", provider: "openai-compatible", baseUrl: "http://127.0.0.1:8081/v1", port: 8081, model: "glm-4.7-flash-ud-q3-k-xl" };
      },
      readMetrics: async () => {
        metricReads += 1;
        return metricReads % 2 === 1
          ? { promptTokens: 100, promptSeconds: 2, generatedTokens: 50, generationSeconds: 1 }
          : { promptTokens: 300, promptSeconds: 3, generatedTokens: 150, generationSeconds: 1.8 };
      },
      launch: async () => ({ exitCode: 0, output: "done", runResult: { finishReason: "completed" } }),
    });

    const { RUN } = await import("../src/run-budget.mjs");
    const usageBefore = { ...RUN.usage };
    await worker.run("first", { onEvent: async (event) => events.push(event) });
    await worker.run("second", { onEvent: async (event) => events.push(event) });
    // Local tokens count toward token budgets: 200 prompt and 100 generated tokens per attempt.
    assert.deepEqual([RUN.usage.input - usageBefore.input, RUN.usage.output - usageBefore.output], [400, 200]);

    assert.equal(readyChecks, 2);
    assert.equal(metricReads, 4);
    const ready = events.filter((event) => event.type === "cline-provider-ready");
    assert.equal(ready.length, 2);
    assert.equal(ready[0].requestedProvider, "llamacpp");
    assert.equal(ready[0].provider, "openai-compatible");
    assert.equal(ready[0].port, 8081);
    assert.equal(ready[0].model, "glm-4.7-flash-ud-q3-k-xl");
    const metrics = events.filter((event) => event.type === "cline-provider-metrics");
    assert.equal(metrics.length, 2);
    // Each attempt's samples share runStartedAt (partial samples during long attempts use it too).
    assert.match(metrics[0].runStartedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.notEqual(metrics[0].runStartedAt, undefined);
    const { runStartedAt: _first, ...firstMetrics } = metrics[0];
    assert.deepEqual(firstMetrics, {
      type: "cline-provider-metrics",
      requestedProvider: "llamacpp",
      provider: "openai-compatible",
      baseUrl: "http://127.0.0.1:8081/v1",
      model: "glm-4.7-flash-ud-q3-k-xl",
      promptTokens: 200,
      generatedTokens: 100,
      promptTokensPerSecond: 200,
      generationTokensPerSecond: 125,
      failed: false,
    });
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

test("llama.cpp readiness failure logs provider identity and does not launch or fall back", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "cline-llamacpp-failure-"));
  const events = [];
  let launches = 0;
  try {
    const worker = new ClineCliWorker({
      stateDir,
      workspace: stateDir,
      provider: "openai-compatible",
      requestedProvider: "llamacpp",
      model: "glm-4.7-flash-ud-q3-k-xl",
      baseUrl: "http://127.0.0.1:8081/v1",
      beforeRun: async () => { throw new Error("required model was not advertised"); },
      launch: async () => { launches += 1; return { exitCode: 0 }; },
    });

    await assert.rejects(
      worker.run("bounded task", { onEvent: async (event) => events.push(event) }),
      /required model was not advertised/,
    );
    assert.equal(launches, 0);
    assert.deepEqual(events, [{
      type: "cline-provider-validation-failed",
      requestedProvider: "llamacpp",
      provider: "openai-compatible",
      baseUrl: "http://127.0.0.1:8081/v1",
      port: 8081,
      model: "glm-4.7-flash-ud-q3-k-xl",
      error: "required model was not advertised",
      fallbackAttempted: false,
    }]);
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

test("Ollama context preflight writes an automation-owned 98K provider setting", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "cline-context-"));
  const module = await import("../src/cline-runtime-config.mjs");
  let request;
  try {
    const result = await module.prepareClineRuntime({
      stateDir,
      provider: "ollama",
      model: "glm-test",
      contextTokens: 98_304,
      timeoutSeconds: 1_800,
      fetchImpl: async (url, options) => {
        request = { url, options };
        return { ok: true, json: async () => ({ model_info: { "glm.context_length": 131_072 } }) };
      },
    });

    assert.equal(JSON.parse(request.options.body).model, "glm-test");
    assert.equal(result.declaredContextTokens, 131_072);
    assert.equal(result.contextTokens, 98_304);
    const settings = JSON.parse(await readFile(path.join(result.dataDir, "settings", "providers.json"), "utf8"));
    assert.equal(settings.providers.ollama.settings.contextWindow, 98_304);
    assert.equal(settings.providers.ollama.settings.model, "glm-test");
    assert.equal(settings.providers.ollama.settings.timeout, 1_800_000);
    assert.equal(settings.providers.ollama.settings.baseUrl, "http://127.0.0.1:11434");
    assert.equal(settings.providers.ollama.tokenSource, "manual");
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

test("custom Ollama host is both preflighted and persisted for Cline", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "cline-context-host-"));
  const { prepareClineRuntime } = await import("../src/cline-runtime-config.mjs");
  let requestedUrl;
  try {
    const result = await prepareClineRuntime({
      stateDir, provider: "ollama", model: "glm-test", contextTokens: 65_536, timeoutSeconds: 900,
      ollamaUrl: "http://ollama.example:11434/",
      fetchImpl: async (url) => { requestedUrl = url; return { ok: true, json: async () => ({ model_info: { context_length: 65_536 } }) }; },
    });
    const settings = JSON.parse(await readFile(path.join(result.dataDir, "settings", "providers.json"), "utf8"));
    assert.equal(requestedUrl, "http://ollama.example:11434/api/show");
    assert.equal(settings.providers.ollama.settings.baseUrl, "http://ollama.example:11434");
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

test("non-Ollama providers bypass Ollama metadata preflight", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "cline-context-provider-"));
  const { prepareClineRuntime } = await import("../src/cline-runtime-config.mjs");
  let fetched = false;
  try {
    const result = await prepareClineRuntime({
      stateDir, provider: "sapaicore", model: "other", contextTokens: 98_304, timeoutSeconds: 1_800,
      fetchImpl: async () => { fetched = true; throw new Error("must not fetch"); },
    });
    assert.equal(fetched, false);
    assert.equal(result.dataDir, undefined);
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

test("OpenCode Console preflight uses its catalog URL and strips the CLI model prefix", async () => {
  const { createProviderDescriptor } = await import("../src/runtime/provider.mjs");
  let requested;
  const descriptor = createProviderDescriptor({
    provider: "opencode", model: "opencode/deepseek-v4.1-flash-free", providerApiKeyEnv: "TEST_OPENCODE_KEY",
    env: { TEST_OPENCODE_KEY: "unit" },
    fetchImpl: async (url, options) => {
      requested = { url, options };
      return { ok: true, json: async () => ({ data: [{ id: "deepseek-v4.1-flash-free" }] }) };
    },
  });

  assert.equal(descriptor.baseUrl, "https://opencode.ai/inference/openai/v1");
  assert.equal(descriptor.model, "deepseek-v4.1-flash-free");
  assert.equal((await descriptor.preflight()).model, "deepseek-v4.1-flash-free");
  assert.equal(requested.url, "https://opencode.ai/inference/v1/models");
  assert.equal(requested.options.headers.authorization, "Bearer unit");
});

test("Cline remaps the Agent Dock key to OpenCode Console's expected environment name", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "cline-opencode-"));
  const priorKey = process.env.AGENT_DOCK_PROVIDER_KEY;
  process.env.AGENT_DOCK_PROVIDER_KEY = "unit";
  try {
    const { prepareClineRuntime } = await import("../src/cline-runtime-config.mjs");
    const runtime = await prepareClineRuntime({
      stateDir, provider: "opencode", model: "opencode/deepseek-v4.1-flash-free", contextTokens: 65_536,
      maxOutputTokens: 4_096, timeoutSeconds: 900,
      fetchImpl: async () => ({ ok: true, json: async () => ({ data: [{ id: "deepseek-v4.1-flash-free" }] }) }),
    });
    await runtime.ensureReady();
    const settings = JSON.parse(await readFile(path.join(runtime.dataDir, "settings", "providers.json"), "utf8"));

    assert.equal(runtime.provider, "openai-compatible");
    assert.equal(runtime.model, "deepseek-v4.1-flash-free");
    assert.equal(runtime.baseUrl, "https://opencode.ai/inference/openai/v1");
    assert.deepEqual(runtime.providerEnv, { OPENAI_API_KEY: "unit" });
    assert.equal(settings.providers["openai-compatible"].settings.model, "deepseek-v4.1-flash-free");
    assert.equal(settings.providers["openai-compatible"].settings.baseUrl, runtime.baseUrl);
  } finally {
    if (priorKey === undefined) delete process.env.AGENT_DOCK_PROVIDER_KEY;
    else process.env.AGENT_DOCK_PROVIDER_KEY = priorKey;
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("Ollama context preflight rejects insufficient metadata without reducing context", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "cline-context-small-"));
  const { prepareClineRuntime } = await import("../src/cline-runtime-config.mjs");
  try {
    await assert.rejects(prepareClineRuntime({
      stateDir, provider: "ollama", model: "glm-test", contextTokens: 98_304, timeoutSeconds: 1_800,
      fetchImpl: async () => ({ ok: true, json: async () => ({ model_info: { "glm.context_length": 65_536 } }) }),
    }), /declares 65536.*requested 98304/i);
    await assert.rejects(readFile(path.join(stateDir, "cline-data", "settings", "providers.json"), "utf8"), /ENOENT/);
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

test("Ollama context preflight rejects missing context metadata", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "cline-context-missing-"));
  const { prepareClineRuntime } = await import("../src/cline-runtime-config.mjs");
  try {
    await assert.rejects(prepareClineRuntime({
      stateDir, provider: "ollama", model: "glm-test", contextTokens: 98_304, timeoutSeconds: 1_800,
      fetchImpl: async () => ({ ok: true, json: async () => ({ model_info: {} }) }),
    }), /missing.*context.*metadata/i);
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

test("Cline CLI uses the automation-owned data directory", () => {
  const args = buildClineArgs({
    clineJs: "cline-js", workspace: "workspace", provider: "ollama", model: "glm-test",
    timeoutSeconds: 1_800, dataDir: "isolated-data", prompt: "Implement",
  });

  assert.deepEqual(args.slice(args.indexOf("--data-dir"), args.indexOf("--data-dir") + 2), ["--data-dir", "isolated-data"]);
  assert.deepEqual(args.slice(args.indexOf("--timeout"), args.indexOf("--timeout") + 2), ["--timeout", "1800"]);
});

test("an existing run lock reports busy without launching Cline", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "cline-adapter-"));
  await writeFile(path.join(stateDir, "cline.busy.lock"), `${process.pid}\n`);
  let launches = 0;
  const worker = new ClineCliWorker({
    stateDir,
    workspace: stateDir,
    checkExternalBusy: async () => false,
    launch: async () => {
      launches += 1;
      return { exitCode: 0, output: "" };
    },
  });

  assert.equal(await worker.isBusy(), true);
  assert.equal(launches, 0);
  await rm(stateDir, { recursive: true, force: true });
});

test("run passes the prompt to Cline and removes its lock after process exit", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "cline-adapter-"));
  const promptPath = path.join(stateDir, "prompt.txt");
  const worker = new ClineCliWorker({
    stateDir,
    workspace: stateDir,
    checkExternalBusy: async () => false,
    launch: async ({ prompt }) => {
      await writeFile(promptPath, prompt);
      return { exitCode: 0, output: "done" };
    },
  });

  const result = await worker.withExclusive(() => worker.run("Implement the isolated task"));

  assert.deepEqual(result, { exitCode: 0, output: "done" });
  assert.equal(await readFile(promptPath, "utf8"), "Implement the isolated task");
  assert.equal(await worker.isBusy(), false);
  await rm(stateDir, { recursive: true, force: true });
});

test("a second manager queues when the first manager holds the lock", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "cline-adapter-"));
  const options = {
    stateDir,
    workspace: stateDir,
    checkExternalBusy: async () => false,
    launch: async () => ({ exitCode: 0, output: "done" }),
  };
  const first = new ClineCliWorker(options);
  const second = new ClineCliWorker(options);
  let releaseFirst;
  const held = new Promise((resolve) => (releaseFirst = resolve));
  let entered;
  const firstRun = first.withExclusive(async () => {
    entered = true;
    await held;
    return "first";
  });
  while (!entered) await new Promise((resolve) => setTimeout(resolve, 1));

  assert.equal(await second.withExclusive(async () => "second"), null);
  releaseFirst();
  assert.equal(await firstRun, "first");
  await rm(stateDir, { recursive: true, force: true });
});

test("a stale lock from a dead process does not wait forever", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "cline-adapter-"));
  await writeFile(path.join(stateDir, "cline.busy.lock"), "2147483647\n");
  const worker = new ClineCliWorker({
    stateDir,
    workspace: stateDir,
    checkExternalBusy: async () => false,
    launch: async () => ({ exitCode: 0, output: "done" }),
  });

  assert.equal(await worker.isBusy(), false);
  assert.equal(await worker.withExclusive(async () => "ran"), "ran");
  await rm(stateDir, { recursive: true, force: true });
});
