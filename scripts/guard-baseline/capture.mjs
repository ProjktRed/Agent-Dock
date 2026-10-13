#!/usr/bin/env node
// Record today's guard behavior precisely enough that Part 2 can be proven to change nothing.
//
//   node scripts/guard-baseline/capture.mjs --impl old --out baseline/old
//   node scripts/guard-baseline/capture.mjs --impl old --tier B --out baseline/old-cline
//
// Tier A is the authoritative baseline: no Cline, no model, no network. It drives
// prepareToolGuard, the SDK plugin in-process and the generated file hooks as subprocesses, over
// every scripted scenario and every direct case, and records each control object verbatim.
//
// Tier B is fidelity confirmation: a real Cline CLI driven by the stub server on 127.0.0.1, so the
// wire format Cline actually sends (the narrowed tool list, the run_commands enum) is recorded
// too. It needs --cline-js (or CLINE_JS) and never talks to a real provider.
//
// Flags
//   --impl old|new        which guard implementation to drive (default old)
//   --tier A|B|both       which tier to record (default A)
//   --out <dir>           output root, relative to scripts/guard-baseline (default baseline/<impl>)
//   --only <name,...>     restrict to these case names
//   --cline-js <path>     Cline CLI entry script for Tier B
//   --timeout-seconds <n> per-scenario wall clock for Tier B (default 180)
//   --context-tokens <n>  Cline context window for Tier B (default 32768)

import http from "node:http";
import { execFile, spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { MODEL_SCENARIOS, SEED_FILES, TASK, GUARD_ALLOWED_TOOLS, materializeScenario } from "./scenarios.mjs";
import { DIRECT_CASES } from "./direct-cases.mjs";
import { CODEX_CASES, CODEX_FAILURE_CASES, CODEX_POLICY } from "./codex-cases.mjs";
import { MUST_NOT_RECOVER, REASONS } from "./inventory.mjs";
import { deriveStrings, snapshotForRecord, snapshotTree } from "./lib/derive.mjs";
import { makeNormalizer } from "./lib/normalize.mjs";
import { CODEX_HOOK, GUARD_MODULE, REPO_ROOT, createRunner, expandScenario, materialize, workRoot } from "./lib/runner.mjs";

const exec = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
    flags[key] = value;
  }
  return flags;
}

const flags = parseFlags(process.argv.slice(2));
const impl = flags.impl ?? "old";
const tier = (flags.tier ?? "A").toUpperCase();
if (!GUARD_MODULE[impl]) throw new Error(`--impl must be old or new, got "${impl}"`);
if (!["A", "B", "BOTH"].includes(tier)) throw new Error(`--tier must be A, B or both, got "${flags.tier}"`);
const outRoot = path.resolve(HERE, flags.out ?? path.join("baseline", impl));
const only = flags.only && flags.only !== "true" ? new Set(flags.only.split(",").map((name) => name.trim())) : null;
const clineJs = flags["cline-js"] ?? process.env.CLINE_JS ?? null;
const tierBTimeoutMs = Number(flags["timeout-seconds"] ?? 180) * 1000;
const contextTokens = Number(flags["context-tokens"] ?? 32_768);

const fixture = {
  ...JSON.parse(await readFile(path.join(HERE, "fixtures", "cline-tool-catalog.json"), "utf8")),
  guardAllowedTools: GUARD_ALLOWED_TOOLS,
};

// Problems go to stdout, not stderr: the engine's own diagnostics (dashboard-state.mjs
// atomicWriteJson) write to stderr, so `2>/dev/null` has to stay safe for reading a run.
//
// Two severities. A failure means the recording cannot be trusted as a baseline and the run exits
// non-zero. A finding is something real and worth reading that does not invalidate the recording —
// Cline's own telemetry attempt is the motivating example.
const failures = [];
const findings = [];
const note = (message, { fatal = true } = {}) => {
  (fatal ? failures : findings).push(message);
  console.log(`${fatal ? "!" : "·"} ${message}`);
};

// ── Tier A ─────────────────────────────────────────────────────────────────────────────────────

async function captureTierA() {
  const { canRecoverOperational } = await import(path.join(REPO_ROOT, "engine", "src", "blocked-resolver.mjs"));
  const cases = [
    ...MODEL_SCENARIOS.map((scenario) => ({ name: scenario.name, kind: "model", scenario, covers: scenario.covers })),
    ...DIRECT_CASES.map((entry) => ({ name: entry.name, kind: "direct", steps: entry.steps, covers: entry.covers })),
  ].filter((entry) => !only || only.has(entry.name));

  const recorded = [];
  for (const entry of cases) {
    const runner = await createRunner({ impl, caseName: entry.name, seedFiles: SEED_FILES, task: TASK, fixture });
    const { context } = runner;
    const normalizer = makeNormalizer({ tokens: runner.tokens });
    const destination = path.join(outRoot, entry.name);
    await rm(destination, { recursive: true, force: true });
    await mkdir(destination, { recursive: true });

    await writeFile(path.join(destination, "prepare.json"),
      JSON.stringify(normalizer.valuePaths(context.prepared), null, 2) + "\n", "utf8");
    await snapshotTree(path.dirname(context.prepared.policyPath), normalizer, path.join(destination, "artifacts"));

    const steps = entry.kind === "model"
      ? expandScenario(materializeScenario(entry.scenario, context.workspace), context.registry)
      : entry.steps;

    const events = [];
    let seq = 0;
    for (const spec of steps) {
      seq += 1;
      const resolved = await runner.resolveStep(spec, seq);
      const policyBefore = await runner.readPolicy();
      let control;
      try { control = await runner.execute(resolved, seq); }
      catch (error) { control = { harnessThrew: { name: error.name, message: error.message } }; }
      const policyAfter = await runner.readPolicy();
      events.push({
        seq,
        at: resolved.at,
        input: normalizer.valuePaths(resolved.input),
        control: control === undefined ? { undefined: true } : normalizer.value(control),
        policyBefore: snapshotForRecord(policyBefore, normalizer),
        policyAfter: snapshotForRecord(policyAfter, normalizer),
      });
    }
    await writeFile(path.join(destination, "decisions.ndjson"), events.map((event) => JSON.stringify(event)).join("\n") + "\n", "utf8");

    const strings = await deriveStrings({ guard: context.guard, prepared: context.prepared, stateDir: context.stateDir, events, normalizer, canRecoverOperational });
    await writeFile(path.join(destination, "strings.json"), JSON.stringify({ covers: entry.covers ?? [], ...strings }, null, 2) + "\n", "utf8");
    await runner.cleanup();
    recorded.push({ name: entry.name, kind: entry.kind, events: events.length, strings });
    console.log(`  ${entry.name}: ${events.length} decisions`);
  }
  return recorded;
}

// ── Tier A, Codex rail ─────────────────────────────────────────────────────────────────────────

async function captureCodexRail() {
  const base = workRoot("codex");
  await rm(base, { recursive: true, force: true });
  await mkdir(base, { recursive: true });
  const workspace = path.join(base, "workspace");
  await mkdir(path.join(workspace, "src", "inscope"), { recursive: true });
  for (const [relative, body] of Object.entries(SEED_FILES)) {
    await mkdir(path.dirname(path.join(workspace, relative)), { recursive: true });
    await writeFile(path.join(workspace, relative), body);
  }
  const normalizer = makeNormalizer({ tokens: { REPO: REPO_ROOT, RUN: base, WS: workspace } });
  const destination = path.join(outRoot, "codex-scope-rail");
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });

  const events = [];
  let seq = 0;
  for (const toolGuard of [true, false]) {
    for (const entry of [...CODEX_CASES.map((c) => ({ ...c, failure: null })), ...CODEX_FAILURE_CASES.map((c) => ({ ...c, failure: true }))]) {
      seq += 1;
      const runDir = path.join(base, "codex", String(seq));
      await mkdir(runDir, { recursive: true });
      const policyFile = path.join(runDir, "scope-policy.json");
      const logFile = path.join(runDir, "scope-hook.ndjson");
      const policy = { workspace, ...CODEX_POLICY, toolGuard };
      if (entry.policy === "corrupt") await writeFile(policyFile, '{"workspace":', "utf8");
      else if (entry.policy !== "missing") await writeFile(policyFile, JSON.stringify(policy), "utf8");
      const stdin = entry.stdin !== undefined ? entry.stdin : JSON.stringify({ ...materialize(entry.event, workspace), cwd: workspace });
      const result = spawnSync(process.execPath, [CODEX_HOOK, policyFile, logFile], { input: stdin, encoding: "utf8" });
      const log = await readFile(logFile, "utf8").catch(() => "");
      events.push({
        seq,
        at: "codex.PreToolUse",
        case: entry.name,
        toolGuard,
        input: { policy: entry.policy ?? "written", stdin: normalizer.pathsOnly(stdin) },
        control: {
          exitCode: result.status,
          stderr: normalizer.text(result.stderr ?? ""),
          stdout: normalizer.text(result.stdout ?? ""),
          logLines: log.trim().split("\n").filter(Boolean).map((line) => normalizer.text(line)),
        },
        ...(entry.note ? { note: entry.note } : {}),
      });
    }
  }
  await writeFile(path.join(destination, "decisions.ndjson"), events.map((event) => JSON.stringify(event)).join("\n") + "\n", "utf8");
  await writeFile(path.join(destination, "prepare.json"),
    JSON.stringify({ hook: "{REPO}/engine/src/codex-scope-hook.mjs", policy: { workspace: "{WS}", ...CODEX_POLICY, toolGuard: "both true and false" } }, null, 2) + "\n", "utf8");
  // The Codex rail is stateless: no policy.json, no counters, no stop concept, and deliberately
  // no entry in OPERATIONALLY_RECOVERABLE. Nothing composes a worker error from these reasons.
  await writeFile(path.join(destination, "strings.json"), JSON.stringify({
    covers: ["the Codex PreToolUse rail, exit code and exact stderr, with toolGuard true and false"],
    stateless: true,
    reasons: [...new Set(events.filter((event) => event.control.exitCode === 2).map((event) => event.control.stderr))]
      .map((stderr) => ({ raw: stderr, reason: stderr, hadCancelPrefix: false, stopMessage: null, cancelMessage: null, canRecoverOperational: false })),
  }, null, 2) + "\n", "utf8");
  await rm(base, { recursive: true, force: true });
  console.log(`  codex-scope-rail: ${events.length} decisions`);
  return [{ name: "codex-scope-rail", kind: "codex", events: events.length, strings: { reasons: [] }, rawEvents: events }];
}

// ── Tier B ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Every outbound request that honors proxy environment variables lands here and is refused, so a
 * Cline run that tried to reach anything but the stub leaves a record. NO_PROXY keeps the stub on
 * 127.0.0.1 direct. This catches proxy-aware clients only — the other two closures are that no
 * provider credential is in the child env at all, and that the generated providers.json points at
 * the stub.
 */
async function startProxySink() {
  const attempts = [];
  // Refusing a tunnel resets the client's socket, and an unhandled socket error would take the
  // capture process down with it. Every socket here is deliberately swallowed.
  const quiet = (socket) => socket.on("error", () => {});
  const server = http.createServer((request, response) => {
    quiet(request.socket);
    attempts.push({ kind: "request", method: request.method, url: request.url, host: request.headers.host ?? null });
    response.on("error", () => {});
    response.writeHead(502, { "content-type": "text/plain" });
    response.end("guard-baseline: outbound traffic is not allowed\n");
  });
  server.on("connect", (request, socket) => {
    quiet(socket);
    attempts.push({ kind: "connect", method: "CONNECT", url: request.url, host: request.headers.host ?? null });
    socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
  });
  server.on("clientError", (_error, socket) => { quiet(socket); socket.destroy(); });
  server.on("error", (error) => note(`proxy sink error: ${error.message}`));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, attempts, close: () => new Promise((resolve) => server.close(resolve)) };
}

// Hosts that would mean a real model was reached. Cline's telemetry (data.cline.bot) and the npm
// registry (reached by the task's own `npm run check` / `npx prettier`) are deliberately not here:
// they are recorded as findings, not as a breach of the no-real-model constraint.
const MODEL_HOST_PATTERN = /^(?:api\.cline\.bot|api\.anthropic\.com|api\.openai\.com|openrouter\.ai|generativelanguage\.googleapis\.com|[^.]*bedrock[^.]*\.amazonaws\.com|api\.deepseek\.com|api\.x\.ai|api\.groq\.com|api\.mistral\.ai|api\.together\.xyz)(?::\d+)?$/i;
const PROVIDER_HOST_PATTERN = /api\.cline\.bot|api\.anthropic\.com|api\.openai\.com|openrouter\.ai|generativelanguage\.googleapis\.com|api\.deepseek\.com|api\.x\.ai/gi;
const CREDENTIAL_ENV = /^(?:CLINE_API_KEY|CLINE_PASS|CLINE_USER_ID|ANTHROPIC_|OPENAI_|OPENROUTER_|GEMINI_|GOOGLE_|AWS_|DEEPSEEK_|XAI_|GROQ_|MISTRAL_|TOGETHER_|AZURE_)/i;

async function captureTierB() {
  if (!clineJs) throw new Error("Tier B needs --cline-js <path to the Cline CLI entry script> (or CLINE_JS)");
  const { startStub } = await import("./stub-llamacpp.mjs");
  const { prepareClineRuntime } = await import(path.join(REPO_ROOT, "engine", "src", "cline-runtime-config.mjs"));
  const { buildClineArgs, launchCline } = await import(path.join(REPO_ROOT, "engine", "src", "cline-cli-worker.mjs"));
  const guard = await import(GUARD_MODULE[impl]);
  const { canRecoverOperational } = await import(path.join(REPO_ROOT, "engine", "src", "blocked-resolver.mjs"));
  const scenarios = MODEL_SCENARIOS.filter((scenario) => !only || only.has(scenario.name));
  const recorded = [];
  for (const scenario of scenarios) {
    const base = workRoot("tierB");
    await rm(base, { recursive: true, force: true });
    await mkdir(base, { recursive: true });
    const workspace = path.join(base, "workspace");
    const stateDir = path.join(base, "state");
    const home = path.join(base, "home");
    for (const directory of [workspace, stateDir, home]) await mkdir(directory, { recursive: true });
    for (const [relative, body] of Object.entries(SEED_FILES)) {
      await mkdir(path.dirname(path.join(workspace, relative)), { recursive: true });
      await writeFile(path.join(workspace, relative), body);
    }
    await exec("git", ["init", "-q", "-b", "main"], { cwd: workspace });
    await exec("git", ["add", "-A"], { cwd: workspace });
    await exec("git", ["-c", "user.email=guard@baseline.invalid", "-c", "user.name=Guard Baseline", "commit", "-qm", "seed"], { cwd: workspace });
    await writeFile(path.join(stateDir, "current-task.json"), JSON.stringify(TASK, null, 2) + "\n");

    const stub = await startStub({ scenario: materializeScenario(scenario, workspace), logPath: path.join(base, "stub.ndjson") });
    const sink = await startProxySink();
    const runtime = await prepareClineRuntime({
      stateDir, provider: "llamacpp", model: scenario.model ?? "stub-model",
      contextTokens, maxOutputTokens: 4_096, timeoutSeconds: Math.round(tierBTimeoutMs / 1000),
      llamaCppUrl: stub.baseUrl,
    });
    const prepared = await guard.prepareToolGuard({ stateDir, workspace });

    const normalizer = makeNormalizer({
      tokens: { REPO: REPO_ROOT, RUN: base, WS: await realpath(workspace), STATE: await realpath(stateDir), CLINE: path.dirname(path.resolve(clineJs)) },
      volatile: { ports: [stub.port, Number(new URL(sink.url).port)] },
    });

    // Isolate every scrap of user state, and strip any provider credential from the child env.
    const savedEnv = { ...process.env };
    Object.assign(process.env, {
      HOME: home, USERPROFILE: home,
      CLINE_DIR: path.join(home, ".cline"), CLINE_DATA_DIR: runtime.dataDir,
      XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local", "share"),
      XDG_STATE_HOME: path.join(home, ".local", "state"), XDG_CACHE_HOME: path.join(home, ".cache"),
      HTTP_PROXY: sink.url, HTTPS_PROXY: sink.url, http_proxy: sink.url, https_proxy: sink.url, ALL_PROXY: sink.url,
      NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost",
    });
    const strippedEnv = Object.keys(process.env).filter((key) => CREDENTIAL_ENV.test(key));
    for (const key of strippedEnv) delete process.env[key];

    const argv = buildClineArgs({
      clineJs, workspace, provider: runtime.provider, model: runtime.model,
      timeoutSeconds: Math.round(tierBTimeoutMs / 1000),
      dataDir: runtime.dataDir, configDir: prepared.configDir, hooksDir: prepared.hooksDir,
      prompt: TASK.prompt + prepared.instructions,
    });

    const events = [];
    let childPid = null;
    let run;
    const killer = setTimeout(() => {
      if (!childPid) return;
      if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(childPid), "/T", "/F"], { windowsHide: true });
      else { try { process.kill(childPid, "SIGKILL"); } catch { /* already gone */ } }
    }, tierBTimeoutMs);
    try {
      const result = await launchCline({
        clineJs, workspace, provider: runtime.provider, model: runtime.model,
        timeoutSeconds: Math.round(tierBTimeoutMs / 1000),
        dataDir: runtime.dataDir, configDir: prepared.configDir, hooksDir: prepared.hooksDir,
        guardPolicyPath: prepared.policyPath, guardPluginPath: prepared.pluginPath,
        prompt: TASK.prompt + prepared.instructions,
        onStart: ({ pid }) => { childPid = pid; },
        onEvent: (event) => { events.push(event); },
      });
      run = { exitCode: result.exitCode, finishReason: result.runResult?.finishReason ?? null, error: null };
    } catch (error) {
      run = { exitCode: error.exitCode ?? null, finishReason: null, error: error.message };
    } finally {
      clearTimeout(killer);
      for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
      Object.assign(process.env, savedEnv);
    }

    const stubLog = stub.requests;
    const chatRequests = stubLog.filter((entry) => entry.method === "POST" && /\/chat\/completions$/.test(entry.route));
    const providers = JSON.parse(await readFile(path.join(runtime.dataDir, "settings", "providers.json"), "utf8"));
    const providerBaseUrl = providers.providers["openai-compatible"].settings.baseUrl;

    const verification = {
      method: [
        "providers.json baseUrl is compared against the stub's own base URL",
        "the stub counts the chat completion requests it served",
        "every provider credential variable is deleted from the child env before launch",
        "HTTP(S)_PROXY points at a local sink that refuses and logs anything proxy-aware",
        "Cline's own stdout/stderr is scanned for known provider hostnames",
      ],
      stubBaseUrl: stub.baseUrl.replace(`:${stub.port}`, ":{PORT}"),
      providersBaseUrl: providerBaseUrl.replace(`:${stub.port}`, ":{PORT}"),
      providersBaseUrlIsStub: providerBaseUrl === stub.baseUrl,
      providersBaseUrlIsLoopback: /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?/.test(providerBaseUrl),
      providersApiKey: providers.providers["openai-compatible"].settings.apiKey,
      stubRequestCount: stubLog.length,
      stubChatRequestCount: chatRequests.length,
      stubRoutes: [...new Set(stubLog.map((entry) => `${entry.method} ${entry.route}`))],
      stubUnhandled: stubLog.filter((entry) => entry.unhandled).map((entry) => `${entry.method} ${entry.route}`),
      strippedCredentialEnv: strippedEnv.sort(),
      proxySinkAttempts: sink.attempts,
      proxySinkModelProviderAttempts: sink.attempts.filter((attempt) => MODEL_HOST_PATTERN.test(attempt.host ?? "")),
      providerHostnamesInOutput: [...new Set((events.map((event) => JSON.stringify(event)).join("\n").match(PROVIDER_HOST_PATTERN) ?? []))],
    };
    if (!verification.providersBaseUrlIsStub) note(`Tier B ${scenario.name}: providers.json baseUrl ${providerBaseUrl} is not the stub's ${stub.baseUrl}`);
    if (!verification.providersBaseUrlIsLoopback) note(`Tier B ${scenario.name}: providers.json baseUrl is not on loopback`);
    if (!chatRequests.length) note(`Tier B ${scenario.name}: the stub served no chat completion request`);
    const modelAttempts = sink.attempts.filter((attempt) => MODEL_HOST_PATTERN.test(attempt.host ?? ""));
    const otherAttempts = [...new Set(sink.attempts.filter((attempt) => !modelAttempts.includes(attempt)).map((attempt) => attempt.host))];
    if (modelAttempts.length) note(`Tier B ${scenario.name}: ${modelAttempts.length} outbound request(s) to a model provider were attempted: ${JSON.stringify(modelAttempts)}`);
    if (otherAttempts.length) note(`Tier B ${scenario.name}: non-model outbound traffic refused by the proxy sink: ${otherAttempts.join(", ")}`, { fatal: false });
    if (verification.providerHostnamesInOutput.length) note(`Tier B ${scenario.name}: provider hostnames in Cline output: ${verification.providerHostnamesInOutput.join(", ")}`);
    if (verification.stubUnhandled.length) note(`Tier B ${scenario.name}: the stub 404'd ${verification.stubUnhandled.join(", ")}`, { fatal: false });

    const destination = path.join(outRoot, scenario.name);
    await rm(destination, { recursive: true, force: true });
    await mkdir(destination, { recursive: true });
    await writeFile(path.join(destination, "prepare.json"), JSON.stringify(normalizer.valuePaths(prepared), null, 2) + "\n", "utf8");
    await snapshotTree(path.dirname(prepared.policyPath), normalizer, path.join(destination, "artifacts"));
    await writeFile(path.join(destination, "argv.json"), JSON.stringify({ node: "{NODE}", argv: normalizer.value(argv) }, null, 2) + "\n", "utf8");
    await writeFile(path.join(destination, "providers.json"), JSON.stringify(normalizer.value(providers), null, 2) + "\n", "utf8");
    await writeFile(path.join(destination, "stub-requests.ndjson"),
      stubLog.map((entry) => JSON.stringify(normalizer.value(entry))).join("\n") + "\n", "utf8");
    await writeFile(path.join(destination, "events.ndjson"),
      events.map((event) => JSON.stringify(normalizer.value(event))).join("\n") + "\n", "utf8");
    await writeFile(path.join(destination, "run.json"), JSON.stringify(normalizer.value(run), null, 2) + "\n", "utf8");
    await writeFile(path.join(destination, "stub-verification.json"), JSON.stringify(normalizer.value(verification), null, 2) + "\n", "utf8");

    const strings = await deriveStrings({ guard, prepared, stateDir, events: [{ control: { reason: (await guard.readGuardOutcome(prepared.policyPath)).reason } }], normalizer, canRecoverOperational });
    await writeFile(path.join(destination, "strings.json"), JSON.stringify({ covers: scenario.covers ?? [], ...strings }, null, 2) + "\n", "utf8");

    await sink.close();
    await stub.close();
    await rm(base, { recursive: true, force: true });
    recorded.push({ name: scenario.name, kind: "cline", events: events.length, strings, verification });
    console.log(`  ${scenario.name}: exit ${run.exitCode}, finish ${run.finishReason ?? run.error}, ${chatRequests.length} chat requests, guard reason ${JSON.stringify(strings.guardOutcome.reason ?? null)}`);
  }
  return recorded;
}

// ── inventory coverage ─────────────────────────────────────────────────────────────────────────

async function checkInventory(recorded) {
  const haystack = [];
  for (const entry of recorded) {
    const directory = path.join(outRoot, entry.name);
    for (const file of ["decisions.ndjson", "strings.json", "events.ndjson", "run.json"]) {
      haystack.push(await readFile(path.join(directory, file), "utf8").catch(() => ""));
    }
  }
  const text = haystack.join("\n");
  const encoded = JSON.stringify(text);
  const present = (value) => text.includes(value) || encoded.includes(JSON.stringify(value).slice(1, -1));

  const rows = [];
  for (const reason of REASONS) {
    if (reason.how === "recorded") {
      rows.push({ ...reason, found: present(reason.text) });
      continue;
    }
    const source = await readFile(path.join(REPO_ROOT, reason.file), "utf8");
    rows.push({ ...reason, found: source.includes(reason.text) });
  }
  return rows;
}

// ── run ────────────────────────────────────────────────────────────────────────────────────────

await rm(outRoot, { recursive: true, force: true });
await mkdir(outRoot, { recursive: true });
console.log(`capture --impl ${impl} --tier ${tier} → ${path.relative(REPO_ROOT, outRoot)}`);

let recorded = [];
if (tier === "A" || tier === "BOTH") {
  recorded = [...await captureTierA(), ...(only ? [] : await captureCodexRail())];
}
if (tier === "B" || tier === "BOTH") {
  recorded = [...recorded, ...await captureTierB()];
}

const inventory = await checkInventory(recorded);
const missing = inventory.filter((row) => !row.found);
// Only Tier A owes full coverage. Tier B is a fidelity recording of what a real Cline run reaches,
// which is a strict subset by construction, so its gaps are reported and not treated as failures.
const coverageIsContract = (tier === "A" || tier === "BOTH") && !only;
for (const row of missing) {
  note(`inventory string not ${row.how === "recorded" ? "recorded" : "found in source"}: ${row.id} (${row.source})`, { fatal: coverageIsContract });
}

const recoverable = recorded.flatMap((entry) => (entry.strings?.reasons ?? []).map((reason) => ({ case: entry.name, ...reason })));
const byReason = new Map();
for (const row of recoverable) if (!byReason.has(row.reason)) byReason.set(row.reason, row);
const expectedRecoverable = REASONS.filter((reason) => reason.recoverable);
const verdicts = {
  note: "canRecoverOperational(blocked-resolver.mjs:75) over a synthetic resolver input whose failure.reason is the composed worker error for each recorded reason.",
  recoverableContract: expectedRecoverable.map((reason) => {
    const row = [...byReason.values()].find((candidate) => candidate.reason.startsWith(reason.text));
    return { id: reason.id, text: reason.text, recorded: Boolean(row), canRecoverOperational: row?.canRecoverOperational ?? null, ok: row ? row.canRecoverOperational === true : false };
  }),
  mustNotRecover: MUST_NOT_RECOVER.map((text) => {
    const row = [...byReason.values()].find((candidate) => candidate.reason === text);
    return { text, recorded: Boolean(row), canRecoverOperational: row?.canRecoverOperational ?? null, ok: row ? row.canRecoverOperational === false : false };
  }),
  all: [...byReason.values()].sort((a, b) => a.reason.localeCompare(b.reason)).map(({ case: _case, ...row }) => row),
};
for (const row of verdicts.recoverableContract) {
  if (!row.ok) note(`recoverable contract: ${row.id} recorded=${row.recorded} canRecoverOperational=${row.canRecoverOperational}`, { fatal: coverageIsContract });
}
for (const row of verdicts.mustNotRecover) if (row.recorded && !row.ok) note(`must-not-recover contract: ${JSON.stringify(row.text)} classified recoverable`);

await writeFile(path.join(outRoot, "meta.json"), JSON.stringify({
  tier, impl,
  guardModule: path.relative(REPO_ROOT, GUARD_MODULE[impl]).replaceAll(path.sep, "/"),
  cases: recorded.map(({ name, kind, events }) => ({ name, kind, events })),
  clineVersion: tier === "A" ? null : fixture.clineVersion,
}, null, 2) + "\n", "utf8");
await writeFile(path.join(outRoot, "inventory.json"), JSON.stringify({
  total: inventory.length,
  recorded: inventory.filter((row) => row.how === "recorded" && row.found).length,
  sourceLiteral: inventory.filter((row) => row.how === "source-literal" && row.found).length,
  missing: missing.map((row) => row.id),
  rows: inventory.map(({ id, source, how, kind, found, recoverable: rec }) => ({ id, source, how, kind, found, ...(rec ? { recoverable: true } : {}) })),
}, null, 2) + "\n", "utf8");
await writeFile(path.join(outRoot, "verdicts.json"), JSON.stringify(verdicts, null, 2) + "\n", "utf8");
// Environment detail is deliberately a sibling of the compared tree: compare.mjs has exactly one
// declared allowable difference, and a Node version is not it.
await writeFile(outRoot + "-environment.json", JSON.stringify({
  capturedAt: new Date().toISOString(), node: process.version, platform: `${process.platform} ${process.arch}`,
  tier, impl, clineJs: tier === "A" ? null : clineJs, contextTokens: tier === "A" ? null : contextTokens,
}, null, 2) + "\n", "utf8");

console.log(`\ncases: ${recorded.length}  decisions: ${recorded.reduce((total, entry) => total + entry.events, 0)}`);
console.log(`inventory: ${inventory.filter((row) => row.found).length}/${inventory.length}${coverageIsContract ? "" : " (informational for this tier)"} (${inventory.filter((row) => row.how === "source-literal").length} source-literal)`);
if (findings.length) console.log(`${findings.length} finding(s) recorded, see stub-verification.json`);
if (failures.length) {
  console.log(`\n${failures.length} failure(s). The recording was still written; read it before trusting it.`);
  process.exit(1);
}
console.log("ok");
