import path from "node:path";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { chmod, mkdir, open, rm } from "node:fs/promises";
import { atomicWriteJson } from "./dashboard-state.mjs";
import { createProviderDescriptor } from "./runtime/provider.mjs";

const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
// llama-server's own default port.
const DEFAULT_LLAMACPP_URL = "http://127.0.0.1:8080/v1";
// Script that starts llama.cpp when it is unreachable: --llamacpp-launcher, or the LLAMACPP_LAUNCHER variable.
const DEFAULT_LLAMACPP_LAUNCHER = process.env.LLAMACPP_LAUNCHER || null;

/** Per-slot context of a running llama-server, or null when /props does not report it. */
export async function readLlamaCppSlotContext(fetchImpl, baseUrl, routerModel = null) {
  try {
    const response = await fetchImpl(`${baseUrl.replace(/\/v1$/, "")}/props${modelQuery(routerModel)}`);
    if (!response?.ok) return null;
    const props = await response.json();
    const value = Number(props?.default_generation_settings?.n_ctx ?? props?.n_ctx);
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/** Router mode (llama-server --models-dir) serves /props and /metrics per model: `?model=<id>`. */
const modelQuery = (routerModel) => (routerModel ? `?model=${encodeURIComponent(routerModel)}` : "");

/**
 * Launcher arguments: router mode over a models folder, and the server reasoning switch for the
 * worker's thinking level (the launcher's own settings apply when neither is given).
 */
export function llamaCppLauncherArgs({ modelsDir = null, thinking = "none" } = {}) {
  const args = [];
  if (modelsDir) args.push("-ModelsDir", modelsDir);
  if (thinking && thinking !== "none") args.push("-Reasoning", "on", "-ReasoningEffort", thinking);
  return args;
}

/** llama-server on PATH, or null. */
export function findLlamaServer(env = process.env, platform = process.platform, exists = existsSync) {
  const names = platform === "win32" ? ["llama-server.exe"] : ["llama-server"];
  for (const dir of String(env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean)) {
    for (const name of names) if (exists(path.join(dir, name))) return path.join(dir, name);
  }
  return null;
}

/**
 * Arguments for starting llama-server directly (no launcher script): router mode over the models folder,
 * on the connection's host and port, with metrics for token counts and the context the worker is told.
 */
export function llamaServerArgs({ baseUrl, modelsDir, contextTokens = null, thinking = "none" }) {
  const url = new URL(baseUrl);
  const args = ["--models-dir", modelsDir, "--host", url.hostname, "--port", url.port || "80", "--metrics"];
  if (contextTokens) args.push("--ctx-size", String(contextTokens));
  if (thinking && thinking !== "none") args.push("--reasoning", "on", "--reasoning-effort", thinking);
  return args;
}

function spawnDetached(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      detached: true,
      windowsHide: true,
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve({ pid: child.pid ?? null });
    });
  });
}

/** Starts llama.cpp through a launcher script (.cmd/.bat/.ps1 shim) or llama-server itself. */
function startLlamaCppServer(launcher, launcherArgs = [], { direct = false } = {}) {
  // The server outlives the engine: start it in its own folder, never the engine's working directory
  // (which may sit inside an app install that then cannot be updated).
  if (direct) return spawnDetached(launcher, launcherArgs, path.dirname(launcher));
  return new Promise((resolve, reject) => {
    const child = spawn("cmd.exe", ["/d", "/c", launcher, ...launcherArgs], {
      cwd: path.dirname(launcher),
      detached: true,
      windowsHide: true,
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve({ pid: child.pid ?? null });
    });
  });
}

function llamaRoot(baseUrl) {
  return baseUrl.replace(/\/$/, "").replace(/\/v1$/, "");
}

async function fetchJson(fetchImpl, url) {
  const response = await fetchImpl(url);
  if (!response?.ok) throw new Error(`HTTP ${response?.status ?? "unknown"}`);
  return response.json();
}

async function checkLlamaCpp({ fetchImpl, baseUrl, model }) {
  const root = llamaRoot(baseUrl);
  let health;
  try { health = await fetchJson(fetchImpl, `${root}/health`); }
  catch (error) {
    const failure = new Error(`llama.cpp health check failed at ${root}: ${error.message}`);
    failure.code = "LLAMACPP_UNAVAILABLE";
    throw failure;
  }
  if (health?.status !== "ok") {
    const failure = new Error(`llama.cpp health check at ${root} returned status ${health?.status ?? "unknown"}`);
    failure.code = "LLAMACPP_UNAVAILABLE";
    throw failure;
  }
  const models = await fetchJson(fetchImpl, `${baseUrl.replace(/\/$/, "")}/models`);
  const advertised = Array.isArray(models?.data) ? models.data.map((entry) => entry?.id).filter(Boolean) : [];
  if (!advertised.includes(model)) {
    throw new Error(`llama.cpp at ${baseUrl} does not advertise required model ${model}; advertised: ${advertised.join(", ") || "none"}. Ollama fallback requires explicit --provider ollama.`);
  }
  return { status: health.status, advertisedModels: advertised };
}

function parsePrometheus(text) {
  const values = {};
  for (const line of String(text).split(/\r?\n/)) {
    const match = line.match(/^llamacpp:([^\s{]+)(?:\{[^}]*\})?\s+(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)$/i);
    if (match) values[match[1]] = Number(match[2]);
  }
  return {
    promptTokens: values.prompt_tokens_total ?? 0,
    promptSeconds: values.prompt_seconds_total ?? 0,
    generatedTokens: values.tokens_predicted_total ?? 0,
    generationSeconds: values.tokens_predicted_seconds_total ?? 0,
  };
}

async function readLlamaCppMetrics(fetchImpl, baseUrl, routerModel = null) {
  const response = await fetchImpl(`${llamaRoot(baseUrl)}/metrics${modelQuery(routerModel)}`);
  if (!response?.ok) throw new Error(`llama.cpp metrics failed: HTTP ${response?.status ?? "unknown"}`);
  return parsePrometheus(await response.text());
}

function declaredContext(modelInfo) {
  const values = Object.entries(modelInfo ?? {})
    .filter(([key, value]) => (key === "context_length" || key.endsWith(".context_length")) && Number.isFinite(Number(value)))
    .map(([, value]) => Number(value));
  return values.length ? Math.max(...values) : null;
}

export async function prepareClineRuntime({
  stateDir,
  provider,
  model,
  contextTokens,
  timeoutSeconds,
  fetchImpl = globalThis.fetch,
  ollamaUrl = process.env.OLLAMA_HOST || DEFAULT_OLLAMA_URL,
  llamaCppUrl = DEFAULT_LLAMACPP_URL,
  llamaCppLauncher = DEFAULT_LLAMACPP_LAUNCHER,
  maxOutputTokens = 8_192,
  startServerImpl = startLlamaCppServer,
  findServerImpl = findLlamaServer,
  sleepImpl = sleep,
  startupAttempts = 240,
  startupPollMs = 500,
  llamaCppModelsDir = null,
  thinking = "none",
  providerBaseUrl,
  providerApiKeyEnv = "AGENT_DOCK_PROVIDER_KEY",
  // A parallel task (0.38, --local-server-managed external): the run checked the server before the round,
  // so this engine never starts one (several task engines starting it at once would race).
  externalServer = false,
}) {
  if (provider === "llamacpp") {
    const baseUrl = llamaCppUrl.replace(/\/$/, "");
    const routerModel = llamaCppModelsDir ? model : null;
    let startedServer = false;
    const ensureReady = async () => {
      try {
        await checkLlamaCpp({ fetchImpl, baseUrl, model });
      } catch (error) {
        if (error.code !== "LLAMACPP_UNAVAILABLE") throw error;
        if (externalServer) throw new Error(`${error.message}. A parallel task uses the llama.cpp server the run started or found, and never starts one itself.`);
        // A launcher script wins; otherwise llama-server from PATH serves the models folder directly.
        const server = llamaCppLauncher ? null : llamaCppModelsDir ? findServerImpl() : null;
        if (llamaCppLauncher) await startServerImpl(llamaCppLauncher, llamaCppLauncherArgs({ modelsDir: llamaCppModelsDir, thinking }));
        else if (server) await startServerImpl(server, llamaServerArgs({ baseUrl, modelsDir: llamaCppModelsDir, contextTokens, thinking }), { direct: true });
        else throw new Error(`${error.message}. Start llama.cpp, or set its models folder (with llama-server on PATH) or a launcher script so Agent Dock can start it.`);
        startedServer = true;
        let lastError = error;
        for (let attempt = 0; attempt < startupAttempts; attempt++) {
          if (attempt > 0) await sleepImpl(startupPollMs);
          try {
            await checkLlamaCpp({ fetchImpl, baseUrl, model });
            lastError = null;
            break;
          } catch (retryError) {
            lastError = retryError;
            if (retryError.code !== "LLAMACPP_UNAVAILABLE") throw retryError;
          }
        }
        if (lastError) {
          throw new Error(`llama.cpp did not become ready after ${startupAttempts} checks: ${lastError.message}. No Ollama fallback was attempted; select it explicitly with --provider ollama.`);
        }
      }
      // Cline is told contextWindow=contextTokens; a smaller server slot would overflow silently.
      const serverContext = await readLlamaCppSlotContext(fetchImpl, baseUrl, routerModel);
      if (serverContext !== null && contextTokens && serverContext < contextTokens) {
        throw new Error(`llama.cpp slot context is ${serverContext} tokens, below the requested ${contextTokens}. Raise the server's context size (llama-server -c) and restart it, or lower --cline-context-tokens.`);
      }
      return { requestedProvider: "llamacpp", provider: "openai-compatible", baseUrl, port: Number(new URL(baseUrl).port || 80), model };
    };

    await ensureReady();
    const dataDir = path.join(path.resolve(stateDir), "cline-data");
    await atomicWriteJson(path.join(dataDir, "settings", "providers.json"), {
      version: 1,
      lastUsedProvider: "openai-compatible",
      modes: {},
      providers: {
        "openai-compatible": {
          settings: {
            provider: "openai-compatible",
            client: "openai-compatible",
            protocol: "openai-chat",
            apiKey: "local-no-key",
            model,
            baseUrl,
            contextWindow: contextTokens,
            maxTokens: maxOutputTokens,
            timeout: timeoutSeconds * 1000,
            capabilities: ["tools", "streaming"],
          },
          updatedAt: new Date().toISOString(),
          tokenSource: "manual",
        },
      },
    });
    return {
      dataDir,
      contextTokens,
      maxOutputTokens,
      declaredContextTokens: contextTokens,
      requestedProvider: "llamacpp",
      provider: "openai-compatible",
      model,
      baseUrl,
      port: Number(new URL(baseUrl).port || 80),
      startedServer,
      ensureReady,
      readMetrics: () => readLlamaCppMetrics(fetchImpl, baseUrl, routerModel),
    };
  }
  if (provider === "openrouter" || provider === "opencode" || provider === "openai") {
    const descriptor = createProviderDescriptor({
      provider, model, contextTokens, maxOutputTokens, timeoutSeconds,
      providerBaseUrl, providerApiKeyEnv, fetchImpl,
    });
    const remoteModel = descriptor.model;
    const dataDir = path.join(path.resolve(stateDir), "cline-data");
    const settingsDir = path.join(dataDir, "settings");
    const providersPath = path.join(settingsDir, "providers.json");
    const key = process.env[descriptor.apiKeyEnv];
    const clineProvider = provider === "openrouter" ? "openrouter" : "openai-compatible";
    const writeBackendConfig = async () => {
      await mkdir(settingsDir, { recursive: true, mode: 0o700 });
      await chmod(dataDir, 0o700);
      await chmod(settingsDir, 0o700);
      const settings = {
        provider: clineProvider,
        model: remoteModel,
        ...(provider === "openai" || provider === "opencode" ? { client: "openai-compatible", protocol: "openai-chat", baseUrl: descriptor.baseUrl } : {}),
        contextWindow: contextTokens,
        maxTokens: maxOutputTokens,
        timeout: timeoutSeconds * 1000,
        capabilities: ["tools", "streaming"],
      };
      const document = {
        version: 1,
        lastUsedProvider: clineProvider,
        modes: {},
        providers: {
          [clineProvider]: {
            settings,
            updatedAt: new Date().toISOString(),
            tokenSource: "manual",
          },
        },
      };
      await rm(providersPath, { force: true });
      const handle = await open(providersPath, "wx", 0o600);
      try { await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`); }
      finally { await handle.close(); }
      await chmod(providersPath, 0o600);
    };
    const ensureReady = async () => {
      try {
        const identity = await descriptor.preflight();
        await writeBackendConfig();
        return identity;
      } catch (error) {
        await rm(providersPath, { force: true });
        throw error;
      }
    };
    const cleanupAfterRun = async () => {
      await rm(providersPath, { force: true });
    };
    await descriptor.preflight();
    return {
      dataDir, contextTokens, maxOutputTokens, declaredContextTokens: null,
      requestedProvider: provider, provider: clineProvider, model: remoteModel,
      baseUrl: descriptor.baseUrl, port: Number(new URL(descriptor.baseUrl).port || (new URL(descriptor.baseUrl).protocol === "https:" ? 443 : 80)),
      ensureReady, cleanupAfterRun, readMetrics: null, providerDescriptor: descriptor,
      // opencode maps to Cline's openai-compatible client, which reads OPENAI_API_KEY (not OPENCODE_API_KEY).
      ...((provider === "openrouter" && descriptor.apiKeyEnv !== "OPENROUTER_API_KEY") || ((provider === "openai" || provider === "opencode") && descriptor.apiKeyEnv !== "OPENAI_API_KEY")
        ? { providerEnv: { [provider === "openrouter" ? "OPENROUTER_API_KEY" : "OPENAI_API_KEY"]: key } }
        : {}),
    };
  }
  if (provider !== "ollama") {
    return { dataDir: undefined, contextTokens, maxOutputTokens, declaredContextTokens: null, requestedProvider: provider, provider, model };
  }
  const baseUrl = ollamaUrl.replace(/\/$/, "");
  let response;
  try {
    response = await fetchImpl(`${baseUrl}/api/show`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model }),
    });
  } catch (error) {
    throw new Error(`Ollama context preflight failed for ${model}: ${error.message}`);
  }
  if (!response?.ok) {
    throw new Error(`Ollama context preflight failed for ${model}: HTTP ${response?.status ?? "unknown"}`);
  }
  const metadata = await response.json();
  const declaredContextTokens = declaredContext(metadata?.model_info);
  if (!declaredContextTokens) {
    throw new Error(`Ollama model ${model} is missing declared context metadata; requested ${contextTokens}`);
  }
  if (declaredContextTokens < contextTokens) {
    throw new Error(`Ollama model ${model} declares ${declaredContextTokens} context tokens, below requested ${contextTokens}`);
  }

  const dataDir = path.join(path.resolve(stateDir), "cline-data");
  await atomicWriteJson(path.join(dataDir, "settings", "providers.json"), {
    version: 1,
    lastUsedProvider: "ollama",
    modes: {},
    providers: {
      ollama: {
        settings: {
          provider: "ollama",
          model,
          baseUrl,
          contextWindow: contextTokens,
          timeout: timeoutSeconds * 1000,
        },
        updatedAt: new Date().toISOString(),
        tokenSource: "manual",
      },
    },
  });
  return { dataDir, contextTokens, maxOutputTokens, declaredContextTokens, requestedProvider: "ollama", provider: "ollama", model, baseUrl, port: Number(new URL(baseUrl).port || 80) };
}
