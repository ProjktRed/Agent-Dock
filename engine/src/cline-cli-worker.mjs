import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { diagnostic as defaultDiagnostic } from "./diagnostics.mjs";
import { adapter as clineGuard, prepareToolGuard, readGuardOutcome, verifyRestrictedTools } from "./guard/adapters/cline.mjs";
import { RUNTIME_NOT_READY, ATTEMPT_NOT_COMPLETED, stopMessage } from "./guard/reasons.mjs";
import { withoutSecrets } from "./secret-env.mjs";

// The global npm install of the Cline CLI (%APPDATA%\npm on Windows).
const DEFAULT_CLINE_JS = path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "npm", "node_modules", "cline", "bin", "cline");

const boundedText = (value, limit = 1_000) => typeof value === "string" && value.trim()
  ? value.trim().slice(0, limit)
  : null;

const redactText = (value, secrets) => secrets.reduce((redacted, secret) => redacted.split(secret).join("[REDACTED]"), value);

const MESSAGE_BUFFER_LIMIT = 4_000;
const TEXT_DELTA_TYPES = new Set([
  "assistant_update",
  "assistant_delta",
  "message_delta",
  "text_delta",
  "content_block_delta",
]);

function messageFragment(value) {
  return typeof value === "string" && value.trim()
    ? value.slice(0, MESSAGE_BUFFER_LIMIT)
    : null;
}

function mergeStreamingText(current, next) {
  if (!current) return next.slice(0, MESSAGE_BUFFER_LIMIT);
  if (next.startsWith(current)) return next.slice(0, MESSAGE_BUFFER_LIMIT);
  if (current.endsWith(next)) return current;
  const overlapLimit = Math.min(current.length, next.length);
  for (let size = overlapLimit; size > 0; size--) {
    if (current.endsWith(next.slice(0, size))) {
      return `${current}${next.slice(size)}`.slice(0, MESSAGE_BUFFER_LIMIT);
    }
  }
  return `${current}${next}`.slice(0, MESSAGE_BUFFER_LIMIT);
}

function reconcileFinalMessage(buffer, finalMessage) {
  const buffered = buffer.trim();
  const final = finalMessage.trim();
  if (buffered === final || final.startsWith(buffered)) return finalMessage;
  if (buffered.startsWith(final)) return buffer;
  return null;
}

function parsedToolText(event) {
  if (typeof event?.text !== "string") return null;
  try {
    const value = JSON.parse(event.text);
    return value && typeof value === "object" ? value : null;
  } catch { return null; }
}

const COMPACTION_PHASES = { "auto-compacting": "started", "auto-compacted": "completed", "auto-compaction-skipped": "skipped" };

const listText = (items) => (items.length > 2 ? `${items.slice(0, 2).join(", ")} (+${items.length - 2})` : items.join(", "));

/**
 * Cline 3 agent events: tools arrive as content_start/content_end with contentType "tool", a
 * toolName (read_files, editor, run_commands, search_codebase, …) and its input. Reasoning
 * arrives as contentType "reasoning". Null for anything else.
 */
export function normalizeCline3Event(event) {
  if (event.contentType === "reasoning") return event.type === "content_start" ? { type: "cline-thinking-delta" } : null;
  if (event.contentType !== "tool" || typeof event.toolName !== "string") return null;
  const tool = event.toolName;
  const input = event.input && typeof event.input === "object" ? event.input : {};
  if (event.type === "content_end") {
    const error = boundedText(typeof event.error === "string" ? event.error : event.error?.message);
    return error ? { type: "cline-tool-failed", tool, message: error, action: `${tool} failed: ${error}` } : null;
  }
  if (event.type !== "content_start") return null;
  if (tool === "read_files") {
    const paths = (Array.isArray(input.files) ? input.files : []).map((f) => boundedText(f?.path)).filter(Boolean);
    if (!paths.length && input.path) paths.push(boundedText(input.path));
    return paths.length ? { type: "cline-file-read", path: paths[0], paths, action: `Reading ${listText(paths)}` } : { type: "cline-file-read", action: "Reading files" };
  }
  if (tool === "editor") {
    const filePath = boundedText(input.path);
    if (String(input.command ?? "").toLowerCase() === "view") return { type: "cline-file-read", path: filePath, action: `Reading ${filePath}` };
    return filePath ? { type: "cline-file-modified", path: filePath, action: `Editing ${filePath}` } : null;
  }
  if (tool === "run_commands") {
    const commands = (Array.isArray(input.commands) ? input.commands : [input.command]).map((c) => boundedText(typeof c === "string" ? c : c?.command)).filter(Boolean);
    return commands.length ? { type: "cline-command", commands, action: `Running ${listText(commands)}` } : null;
  }
  if (tool === "search_codebase") {
    const queries = (Array.isArray(input.queries) ? input.queries : [input.query]).map((q) => boundedText(q)).filter(Boolean);
    return { type: "cline-search", ...(queries.length ? { query: queries.join(" | ") } : {}), action: queries.length ? `Searching for ${listText(queries)}` : "Searching workspace" };
  }
  if (tool === "submit_and_exit") return { type: "cline-tool", tool, action: "Finishing" };
  return { type: "cline-tool", tool, action: `Using ${tool}` };
}

export function normalizeClineEvent(parsed) {
  if (!parsed || typeof parsed !== "object" || parsed.type === "run_result") return null;
  const event = parsed.type === "agent_event" && parsed.event && typeof parsed.event === "object"
    ? parsed.event
    : parsed;
  if (parsed.type === "agent_event" && (event.contentType === "tool" || event.contentType === "reasoning")) return normalizeCline3Event(event);
  const parsedDetail = parsedToolText(event);
  const detail = parsedDetail ?? {};
  const kind = String(detail.tool ?? detail.type ?? event.tool ?? event.name ?? event.type ?? "").toLowerCase();
  const command = boundedText(detail.command ?? event.command);
  const filePath = boundedText(detail.path ?? detail.file ?? event.path ?? event.file);

  if (["execute_command", "command", "command_execution"].includes(kind) && command) {
    return { type: "cline-command", commands: [command], action: `Running ${command}` };
  }
  if (["read_file", "file_read", "read"].includes(kind) && filePath) {
    return { type: "cline-file-read", path: filePath, action: `Reading ${filePath}` };
  }
  if (["write_to_file", "write_file", "file_write", "replace_in_file", "apply_patch", "file_modified"].includes(kind) && filePath) {
    return { type: "cline-file-modified", path: filePath, action: `Modifying ${filePath}` };
  }
  if (["search_files", "search", "grep", "find"].includes(kind)) {
    const query = boundedText(detail.regex ?? detail.query ?? event.query);
    if (filePath || query) return { type: "cline-search", ...(filePath ? { path: filePath } : {}), ...(query ? { query } : {}), action: "Searching workspace" };
  }
  const rawMessage = parsedDetail ? null : messageFragment(event.message ?? event.text);
  if (parsed.type === "agent_event" && event.contentType === "text" && event.type === "content_start" && rawMessage) {
    return { type: "cline-message-delta", fragment: messageFragment(event.accumulated) ?? rawMessage };
  }
  if (parsed.type === "agent_event" && event.contentType === "text" && event.type === "content_end") {
    const finalMessage = boundedText(event.text);
    return finalMessage ? { type: "cline-message", message: finalMessage, action: finalMessage } : null;
  }
  if (rawMessage && TEXT_DELTA_TYPES.has(kind)) {
    return { type: "cline-message-delta", fragment: rawMessage };
  }
  const message = parsedDetail ? null : boundedText(event.message ?? event.text);
  if (message && (parsed.type === "agent_event" || ["say", "message", "progress", "text"].includes(kind) || event.say === "text" || event.say === "progress")) {
    return { type: "cline-message", message, action: message };
  }
  return null;
}

export function collectClineProcess(command, args, {
  cwd,
  env,
  input = "",
  spawnProcess = spawn,
  drainTimeoutMs = 250,
  requireRunResult = true,
  redactValues = [],
  diagnostic = defaultDiagnostic,
  onStart = () => {},
  onEvent = () => {},
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(command, args, {
      cwd,
      ...(env ? { env } : {}),
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let stdoutLine = "";
    let runResult;
    let malformedFinal;
    let exited = false;
    let stdoutEnded = false;
    let stderrEnded = false;
    let settled = false;
    let exitCode = 1;
    let drainTimer;
    let messageBuffer = "";
    let activityTraceCount = 0;
    let activitySequence = 0;
    const traceActivity = process.env.CLINE_ACTIVITY_TRACE === "1";
    const trace = (detail) => {
      if (traceActivity && activityTraceCount++ < 120) diagnostic("CLINE_ACTIVITY_TRACE", detail);
    };
    let eventQueue = Promise.resolve();

    diagnostic("CLINE_START", { command, pid: child.pid ?? null });
    Promise.resolve(onStart({ pid: child.pid ?? null })).catch(reject);

    const queueEvent = (incoming) => {
      // Cline reports context compaction as plain messages; they are bookkeeping, not worker output.
      const phase = incoming.type === "cline-message" ? COMPACTION_PHASES[String(incoming.message ?? "").trim()] : null;
      const event = phase ? { type: "cline-compaction", phase } : incoming;
      const activityId = ++activitySequence;
      trace({ phase: "activity-created", activityId, activityType: event.type, length: event.message?.length ?? event.fragment?.length ?? null, preview: (event.message ?? event.fragment ?? "").slice(0, 40) });
      eventQueue = eventQueue.then(async () => {
        await onEvent(event);
        trace({ phase: "activity-forwarded", activityId, activityType: event.type, transformed: false });
      });
    };
    const queueMessage = (text) => {
      const message = boundedText(text);
      if (message) queueEvent({ type: "cline-message", message, action: message });
      return message;
    };
    const flushMessage = (reason = "boundary") => {
      if (!messageBuffer) return null;
      const buffered = messageBuffer;
      messageBuffer = "";
      const emitted = queueMessage(buffered);
      trace({ phase: "flushed", reason, length: buffered.length, preview: buffered.slice(0, 40) });
      return emitted;
    };
    let thinking = false;
    const handleActivity = (activity) => {
      if (!activity) return;
      // Reasoning streams in many chunks: one "Thinking…" entry per stretch, until something else happens.
      if (activity.type === "cline-thinking-delta") {
        if (!thinking) queueEvent({ type: "cline-thinking", action: "Thinking…" });
        thinking = true;
        return;
      }
      thinking = false;
      if (activity.type === "cline-message-delta") {
        messageBuffer = mergeStreamingText(messageBuffer, activity.fragment);
        trace({ phase: "buffered", length: activity.fragment.length, preview: activity.fragment.slice(0, 40), bufferLength: messageBuffer.length });
        return;
      }
      if (activity.type === "cline-message") {
        if (messageBuffer) {
          const buffered = messageBuffer;
          messageBuffer = "";
          const reconciled = reconcileFinalMessage(buffered, activity.message);
          if (reconciled !== null) queueMessage(reconciled);
          else {
            queueMessage(buffered);
            queueEvent(activity);
          }
          return;
        }
        queueEvent(activity);
        return;
      }
      flushMessage("boundary");
      queueEvent(activity);
    };
    const parseLine = (line) => {
      if (!line.trim()) return;
      try {
        const parsed = JSON.parse(redactText(line, redactValues));
        const activity = normalizeClineEvent(parsed);
        if (activity && traceActivity) {
          const raw = parsed.type === "agent_event" ? parsed.event : parsed;
          const field = typeof raw?.message === "string" ? "message" : typeof raw?.text === "string" ? "text" : null;
          trace({ phase: "raw-normalized", rawType: parsed.type, eventType: raw?.type ?? null, contentType: raw?.contentType ?? null, messageId: raw?.messageId ?? raw?.message_id ?? null, itemId: raw?.itemId ?? raw?.item_id ?? null, contentBlockId: raw?.contentBlockId ?? raw?.content_block_id ?? null, field, length: field ? raw[field].length : 0, preview: field ? raw[field].slice(0, 40) : "", activityType: activity.type });
        }
        handleActivity(activity);
        if (parsed?.type === "run_result") {
          flushMessage("boundary");
          if (typeof parsed.finishReason !== "string" || !parsed.finishReason.trim()) {
            malformedFinal = new Error("run_result.finishReason must be a non-empty string");
          } else {
            runResult = parsed;
            malformedFinal = undefined;
            diagnostic("CLINE_RESULT_PARSED", { finishReason: parsed.finishReason });
          }
        }
      } catch (error) {
        malformedFinal = error;
      }
    };
    const consumeStdout = (chunk) => {
      stdout += chunk;
      stdoutLine += chunk;
      const lines = stdoutLine.split(/\r?\n/);
      stdoutLine = lines.pop() ?? "";
      for (const line of lines) parseLine(line);
    };
    const finish = async () => {
      if (settled || !exited) return;
      settled = true;
      clearTimeout(drainTimer);
      if (stdoutLine) {
        parseLine(stdoutLine);
        stdoutLine = "";
      }
      flushMessage("boundary");
      try { await eventQueue; }
      catch (error) { reject(error); return; }
      const output = redactText(`${stdout}${stderr}`, redactValues);
      if (requireRunResult && !runResult) {
        const detail = malformedFinal ? `; final NDJSON was malformed: ${malformedFinal.message}` : "";
        const error = new Error(`Cline output did not contain a valid final run_result${detail}`);
        error.exitCode = exitCode;
        error.output = output;
        reject(error);
        return;
      }
      resolve({ exitCode, output, runResult, pid: child.pid ?? null });
    };
    const maybeFinish = () => {
      if (exited && stdoutEnded && stderrEnded) void finish();
    };
    const startDrainWindow = () => {
      maybeFinish();
      if (settled) return;
      drainTimer = setTimeout(() => {
        if (!stdoutEnded && !child.stdout.destroyed) child.stdout.destroy();
        if (!stderrEnded && !child.stderr.destroyed) child.stderr.destroy();
        void finish();
      }, drainTimeoutMs);
      drainTimer.unref?.();
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", consumeStdout);
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.stdout.on("end", () => {
      stdoutEnded = true;
      diagnostic("CLINE_STDOUT_END", { pid: child.pid ?? null });
      maybeFinish();
    });
    child.stderr.on("end", () => {
      stderrEnded = true;
      diagnostic("CLINE_STDERR_END", { pid: child.pid ?? null });
      maybeFinish();
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(drainTimer);
      reject(error);
    });
    child.on("exit", (code, signal) => {
      exited = true;
      exitCode = code ?? 1;
      diagnostic("CLINE_EXIT", { pid: child.pid ?? null, exitCode, signal });
      startDrainWindow();
    });
    child.on("close", (code, signal) => {
      diagnostic("CLINE_CLOSE", { pid: child.pid ?? null, exitCode: code ?? 1, signal });
      if (!exited) {
        exited = true;
        exitCode = code ?? 1;
      }
      maybeFinish();
    });
    child.stdin.on("error", (error) => {
      diagnostic("CLINE_STDIN_ERROR", { pid: child.pid ?? null, error: error.message });
    });
    child.stdin.end(input);
  });
}

export async function isAnyClineCliActive(clineJs = DEFAULT_CLINE_JS) {
  const result = await collectClineProcess(process.execPath, [clineJs, "doctor"], {
    requireRunResult: false,
  });
  const plain = result.output.replace(/\x1b\[[0-9;]*m/g, "");
  if (result.exitCode !== 0) throw new Error(`Cline CLI unavailable at ${clineJs}: doctor exited with exit ${result.exitCode}. ${plain.trim().slice(0,1000)} Restore the configured Cline installation before Resume.`);
  const match = plain.match(/cli processes\s+(\d+)/i);
  if (!match) throw new Error(`Cannot determine Cline availability at ${clineJs}: unrecognized doctor output. ${plain.trim().slice(0,1000)} Check the configured CLI before Resume.`);
  return Number(match[1]) > 0;
}

export function buildClineArgs({
  clineJs,
  workspace,
  provider,
  model,
  timeoutSeconds,
  dataDir,
  configDir,
  hooksDir,
  guardLaunchArgs,
  prompt,
  thinking = "none",
}) {
  const args = [
    clineJs,
    "--json",
    "--auto-approve",
    "true",
    "--compaction",
    "agentic",
    "--retries",
    "6",
    "--thinking",
    thinking,
    "--provider",
    provider,
    "--model",
    model,
    "--cwd",
    workspace,
    "--timeout",
    String(timeoutSeconds),
  ];
  if (guardLaunchArgs) args.push(...guardLaunchArgs);
  else {
    if (dataDir) args.push("--data-dir", dataDir);
    if (configDir) args.push("--config", configDir);
    if (hooksDir) args.push("--hooks-dir", hooksDir);
  }
  args.push(prompt);
  return args;
}

export async function launchCline({
  clineJs = DEFAULT_CLINE_JS,
  workspace,
  provider = "ollama",
  model = "glm-4.7-flash:q4_K_M",
  timeoutSeconds = 1_800,
  contextTokens = 98_304,
  dataDir,
  configDir,
  hooksDir,
  prompt,
  onStart,
  onEvent,
  guardPolicyPath,
  guardPluginPath,
  guardLaunchArgs,
  guardEnv,
  launchEnv,
  guardVerify,
  thinking,
}) {
  await access(clineJs, constants.R_OK);
  const guardLaunch = guardPolicyPath
    ? clineGuard.launchConfiguration({ configDir, hooksDir, dataDir, pluginPath: guardPluginPath })
    : null;
  if (guardPolicyPath) await (guardVerify ?? guardLaunch?.verify ?? (() => verifyRestrictedTools({ pluginPath: guardPluginPath })))();
  const args = buildClineArgs({
    clineJs,
    workspace,
    provider,
    model,
    timeoutSeconds,
    dataDir,
    configDir,
    hooksDir,
    guardLaunchArgs: guardLaunchArgs ?? guardLaunch?.launchArgs,
    prompt,
    thinking,
  });
  // Cline may need a cloud provider key (launchEnv adds the renamed one; a custom OPENROUTER_API_KEY /
  // OPENAI_API_KEY is inherited), never the orchestrator CLIs' keys or the app's own variable.
  const env = { ...withoutSecrets(process.env, { keep: ["OPENROUTER_API_KEY", "OPENAI_API_KEY"] }), ...(launchEnv ?? {}), ...(guardPolicyPath ? (guardEnv ?? guardLaunch.env) : {}) };
  const redactValues = Object.values(launchEnv ?? {}).filter((secret) => typeof secret === "string" && secret.length > 0);
  const result = await collectClineProcess(process.execPath, args, { cwd: workspace, env, onStart, onEvent, redactValues });
  if (guardPolicyPath && !(await readGuardOutcome(guardPolicyPath)).runtimeReady) {
    throw new Error(RUNTIME_NOT_READY);
  }
  return result;
}

export class ClineCliWorker {
  constructor({
    stateDir,
    workspace,
    clineJs = DEFAULT_CLINE_JS,
    provider = "ollama",
    model = "glm-4.7-flash:q4_K_M",
    timeoutSeconds = 1_800,
    contextTokens = 98_304,
    dataDir,
    thinking = "none",
    requestedProvider = provider,
    baseUrl,
    beforeRun,
    cleanupAfterRun,
    providerEnv,
    toolGuard = false,
    readMetrics,
    metricsIntervalMs = 30_000,
    checkExternalBusy = () => isAnyClineCliActive(clineJs),
    launch = launchCline,
  }) {
    this.stateDir = path.resolve(stateDir);
    this.lockPath = path.join(this.stateDir, "cline.busy.lock");
    this.options = {
      clineJs: clineJs ?? DEFAULT_CLINE_JS,
      workspace: path.resolve(workspace),
      provider,
      model,
      timeoutSeconds,
      contextTokens,
      dataDir,
      requestedProvider,
      baseUrl,
      thinking,
    };
    this.beforeRun = beforeRun;
    this.cleanupAfterRun = cleanupAfterRun;
    this.providerEnv = providerEnv;
    this.providerSecrets = Object.values(providerEnv ?? {}).filter((secret) => typeof secret === "string" && secret.length > 0);
    this.toolGuard = toolGuard;
    this.readMetrics = readMetrics;
    this.metricsIntervalMs = metricsIntervalMs;
    this.checkExternalBusy = checkExternalBusy;
    this.launch = launch;
  }

  redactProviderSecrets(value) {
    if (!this.providerSecrets.length || typeof value !== "string") return value;
    return this.providerSecrets.reduce((redacted, secret) => redacted.split(secret).join("[REDACTED]"), value);
  }

  redactProviderEvent(value) {
    if (typeof value === "string") return this.redactProviderSecrets(value);
    if (Array.isArray(value)) return value.map((entry) => this.redactProviderEvent(entry));
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, this.redactProviderEvent(entry)]));
    }
    return value;
  }

  async isBusy() {
    try {
      const contents = await readFile(this.lockPath, "utf8");
      const pid = Number(contents.trim());
      let alive = Number.isInteger(pid) && pid > 0;
      if (alive) {
        try {
          process.kill(pid, 0);
        } catch (error) {
          alive = error.code !== "ESRCH";
        }
      }
      if (alive) return true;
      await rm(this.lockPath, { force: true });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return this.checkExternalBusy();
  }

  async run(prompt, hooks = {}) {
    const onEvent = hooks.onEvent ?? (() => {});
    const configuredIdentity = {
      requestedProvider: this.options.requestedProvider,
      provider: this.options.provider,
      baseUrl: this.options.baseUrl,
      port: this.options.baseUrl ? Number(new URL(this.options.baseUrl).port || 80) : null,
      model: this.options.model,
    };
    let identity;
    try {
      identity = this.beforeRun ? await this.beforeRun() : configuredIdentity;
    } catch (error) {
      await onEvent({
        type: "cline-provider-validation-failed",
        ...configuredIdentity,
        error: error.message,
        fallbackAttempted: false,
      });
      throw error;
    }
    let before;
    try {
      await onEvent({ type: "cline-provider-ready", ...identity });
      before = this.readMetrics ? await this.readMetrics() : null;
    } catch (error) {
      if (this.cleanupAfterRun) {
        try { await this.cleanupAfterRun(); } catch { /* preserve the readiness failure */ }
      }
      throw error;
    }
    const runStartedAt = new Date().toISOString();
    const metricsEvent = (after, extra) => {
      const promptTokens = Math.max(0, after.promptTokens - before.promptTokens);
      const generatedTokens = Math.max(0, after.generatedTokens - before.generatedTokens);
      const promptSeconds = Math.max(0, after.promptSeconds - before.promptSeconds);
      const generationSeconds = Math.max(0, after.generationSeconds - before.generationSeconds);
      return {
        type: "cline-provider-metrics",
        runStartedAt,
        requestedProvider: identity.requestedProvider,
        provider: identity.provider,
        baseUrl: identity.baseUrl,
        model: identity.model,
        promptTokens,
        generatedTokens,
        promptTokensPerSecond: promptSeconds > 0 ? promptTokens / promptSeconds : 0,
        generationTokensPerSecond: generationSeconds > 0 ? generatedTokens / generationSeconds : 0,
        ...extra,
      };
    };
    // Live token usage while the attempt runs (llama.cpp counts each finished request); the final
    // sample after the attempt replaces these partial ones.
    let sampler = null;
    if (this.readMetrics && before) {
      sampler = setInterval(() => {
        this.readMetrics().then((now) => onEvent(metricsEvent(now, { partial: true }))).catch(() => {});
      }, this.metricsIntervalMs);
      sampler.unref?.();
    }
    let result;
    let failure;
    try {
      const guard = this.toolGuard ? await prepareToolGuard({ stateDir: this.stateDir, workspace: this.options.workspace }) : null;
      if (guard) await verifyRestrictedTools(guard);
      const guardLaunch = guard ? clineGuard.launchConfiguration({ configDir: guard.configDir, hooksDir: guard.hooksDir, dataDir: this.options.dataDir, pluginPath: guard.pluginPath }) : null;
      const launchOnEvent = this.providerSecrets.length ? (event) => onEvent(this.redactProviderEvent(event)) : onEvent;
      result = await this.launch({ ...this.options, ...hooks, onEvent: launchOnEvent, prompt: prompt + (guard?.instructions ?? ""), ...(this.providerEnv ? { launchEnv: this.providerEnv } : {}), ...(guard ? { configDir: guard.configDir, hooksDir: guard.hooksDir, guardLaunchArgs: guardLaunch.launchArgs, guardEnv: guardLaunch.env, guardVerify: guardLaunch.verify, guardPolicyPath: guard.policyPath, guardPluginPath: guard.pluginPath } : {}) });
      if (typeof result.output === "string") result.output = this.redactProviderSecrets(result.output);
      if (guard) {
        const outcome = await readGuardOutcome(guard.policyPath);
        if (outcome.stopped) {
          await onEvent({ type: "cline-guard-stopped", message: outcome.reason });
          throw new Error(stopMessage(clineGuard.label, outcome.reason));
        }
        if (result.runResult?.finishReason !== "completed") {
          throw new Error(ATTEMPT_NOT_COMPLETED + (result.runResult?.finishReason ?? "missing final result"));
        }
      }
      return result;
    } catch (error) {
      failure = error;
      // Keep the failed attempt's own output; the loop records only the message.
      if (typeof error.output === "string") {
        error.output = this.redactProviderSecrets(error.output);
        try { await writeFile(path.join(this.stateDir, "cline-last-failure.txt"), error.output.slice(-20_000)); } catch { /* diagnostic only */ }
      }
      if (typeof error.message === "string") error.message = this.redactProviderSecrets(error.message);
      throw error;
    } finally {
      if (sampler) clearInterval(sampler);
      try {
        if (this.readMetrics && before) {
          try {
            const after = await this.readMetrics();
            await onEvent(metricsEvent(after, { failed: Boolean(failure || result?.exitCode !== 0) }));
          } catch (metricsError) {
            await onEvent({ type: "cline-provider-metrics-failed", ...identity, error: metricsError.message, failed: Boolean(failure || result?.exitCode !== 0) });
          }
        }
      } finally {
        if (this.cleanupAfterRun) {
          try { await this.cleanupAfterRun(); }
          catch (cleanupError) {
            if (!failure) throw cleanupError;
            await onEvent({ type: "cline-provider-config-cleanup-failed", error: cleanupError.message });
          }
        }
      }
    }
  }

  async withExclusive(operation) {
    await mkdir(this.stateDir, { recursive: true });
    if (await this.isBusy()) return null;
    let lock;
    try {
      lock = await open(this.lockPath, "wx");
    } catch (error) {
      if (error.code === "EEXIST") return null;
      throw error;
    }
    try {
      await lock.writeFile(`${process.pid}\n`);
      if (await this.checkExternalBusy()) return null;
      return await operation();
    } finally {
      await lock.close();
      await rm(this.lockPath, { force: true });
      defaultDiagnostic("BUSY_LOCK_RELEASED", { lockPath: this.lockPath });
    }
  }
}
