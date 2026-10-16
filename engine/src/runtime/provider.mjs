const DEFAULT_OPENROUTER_URL = "https://openrouter.ai/api/v1";
const DEFAULT_OPENCODE_URL = "https://opencode.ai/inference/openai/v1";
const OPENCODE_MODELS_URL = "https://opencode.ai/inference/v1/models";
const API_KEY_ENV_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const REMOTE_PROVIDERS = ["openrouter", "opencode", "openai"];

function normalizedBaseUrl(provider, baseUrl) {
  const value = provider === "openrouter" ? (baseUrl || DEFAULT_OPENROUTER_URL)
    : provider === "opencode" ? (baseUrl || DEFAULT_OPENCODE_URL) : baseUrl;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("--provider-base-url is required for --provider openai");
  }
  let parsed;
  try { parsed = new URL(value); }
  catch { throw new Error("--provider-base-url must be an absolute HTTP(S) URL"); }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("--provider-base-url must be an absolute HTTP(S) URL");
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("--provider-base-url must not contain credentials, query parameters, or a fragment");
  return value.replace(/\/$/, "");
}

export function validateApiKeyEnvName(name = "AGENT_DOCK_PROVIDER_KEY") {
  if (!API_KEY_ENV_PATTERN.test(name)) throw new Error("--provider-api-key-env must be a valid environment variable name");
  return name;
}

/** Remote OpenAI-compatible provider description shared by Cline and OpenCode. */
export function createProviderDescriptor({
  provider,
  model,
  contextTokens,
  maxOutputTokens,
  timeoutSeconds = 1_800,
  timeoutMs,
  providerBaseUrl,
  providerApiKeyEnv = "AGENT_DOCK_PROVIDER_KEY",
  fetchImpl = globalThis.fetch,
  env = process.env,
}) {
  if (!REMOTE_PROVIDERS.includes(provider)) throw new Error(`Unsupported remote provider: ${provider}`);
  const baseUrl = normalizedBaseUrl(provider, providerBaseUrl);
  const normalizedModel = provider === "opencode" ? model.replace(/^opencode\//, "") : model;
  const apiKeyEnv = validateApiKeyEnvName(providerApiKeyEnv);
  const apiKey = env[apiKeyEnv];
  const descriptor = {
    id: provider,
    baseUrl,
    model: normalizedModel,
    apiKeyEnv,
    contextTokens,
    maxOutputTokens,
    timeoutMs: timeoutMs ?? timeoutSeconds * 1000,
    async preflight() {
      if (typeof apiKey !== "string" || !apiKey) throw new Error(`Provider credential is missing from environment variable ${apiKeyEnv}`);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), descriptor.timeoutMs);
      timer.unref?.();
      let response;
      let body;
      try {
        const modelsUrl = provider === "opencode" ? OPENCODE_MODELS_URL : `${baseUrl}/models`;
        response = await fetchImpl(modelsUrl, {
          headers: { authorization: `Bearer ${apiKey}` },
          signal: controller.signal,
        });
        if (!response?.ok) throw new Error(`${provider} model preflight failed: HTTP ${response?.status ?? "unknown"}`);
        body = await response.json();
      } catch (error) {
        if (controller.signal.aborted) throw new Error(`${provider} model preflight timed out after ${descriptor.timeoutMs} ms`);
        throw error;
      } finally {
        clearTimeout(timer);
      }
      const advertisedModels = Array.isArray(body?.data) ? body.data.map((entry) => entry?.id).filter(Boolean) : [];
      if (advertisedModels.length && !advertisedModels.includes(normalizedModel)) {
        throw new Error(`${provider} at ${baseUrl} does not advertise required model ${normalizedModel}; advertised: ${advertisedModels.join(", ")}`);
      }
      return { requestedProvider: provider, provider, baseUrl, model: normalizedModel, advertisedModels };
    },
    readMetrics: null,
    writeBackendConfig: null,
  };
  return descriptor;
}

export function createProvider(options) {
  return createProviderDescriptor(options);
}
