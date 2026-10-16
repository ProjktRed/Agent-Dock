import { parseTuning } from "./engine-tuning.mjs";
import { registerSecretEnv } from "./secret-env.mjs";

export const DEFAULT_CLINE_CONTEXT_TOKENS = 98_304;
// Measured on a consumer GPU with RAM offload (--fit): fits; ~48 tok/s gen at 24K prompt, ~17 tok/s at 68K.
export const DEFAULT_LLAMACPP_CONTEXT_TOKENS = 98_304;
// 8K output so a whole small file can be written in one step (piecemeal edits corrupted files).
export const DEFAULT_LLAMACPP_MAX_OUTPUT_TOKENS = 8_192;
export const DEFAULT_TIMEOUT_SECONDS = 1_800;
export const DEFAULT_LLAMACPP_MODEL = "glm-4.7-flash-ud-q3-k-xl";
export const DEFAULT_OLLAMA_MODEL = "glm-4.7-flash:q4_K_M";

function positiveInteger(value, name, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`--${name} must be a positive integer`);
  return parsed;
}

function booleanOption(value, name, fallback) {
  if (value === undefined) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`--${name} must be true or false`);
}

export const ORCHESTRATOR_ROLES = ["qa", "assessment", "resolver", "elevate"];
export const REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

/** Independent backup settings; Resolver inherits Assessment unless explicitly configured. */
export function parseRoleBackups(options) {
  const backups = {};
  for (const role of ORCHESTRATOR_ROLES) {
    const prefix = `${role}-backup`;
    const cli = options[`${prefix}-cli`];
    let overrides;
    try {
      overrides = parseRoleOverrides(Object.fromEntries(["model", "effort", "fast"].filter(key => options[`${prefix}-${key}`] !== undefined).map(key => [`${role}-${key}`, options[`${prefix}-${key}`]])))[role];
    } catch (error) { throw new Error(error.message.replaceAll(`--${role}-`, `--${prefix}-`)); }
    if (cli === undefined && !overrides) continue;
    if (!["codex", "claude"].includes(cli)) throw new Error(`--${prefix}-cli must be codex or claude`);
    const primary = options[`${role}-cli`] ?? (role === "resolver" ? options["assessment-cli"] : undefined) ?? options.orchestrator ?? "codex";
    if (cli === primary) throw new Error(`--${prefix}-cli must differ from the role's primary CLI`);
    backups[role] = { cli, ...overrides };
  }
  if (!backups.resolver && backups.assessment) {
    const primary = options["resolver-cli"] ?? options["assessment-cli"] ?? options.orchestrator ?? "codex";
    if (backups.assessment.cli === primary) throw new Error("Resolver backup must differ from its primary CLI");
    backups.resolver = { ...backups.assessment };
  }
  return backups;
}

/** --<role>-model, --<role>-effort, --<role>-fast per orchestrator role; only roles with a flag appear. */
export function parseRoleOverrides(options) {
  const overrides = {};
  for (const role of ORCHESTRATOR_ROLES) {
    const model = options[`${role}-model`];
    const effort = options[`${role}-effort`];
    const fast = booleanOption(options[`${role}-fast`], `${role}-fast`, undefined);
    if (effort !== undefined && !REASONING_EFFORTS.includes(effort)) throw new Error(`--${role}-effort must be one of ${REASONING_EFFORTS.join(", ")}`);
    if (model !== undefined && !/^[\w.:\[\]-]+$/.test(model)) throw new Error(`--${role}-model is not a valid model identifier`);
    if (model === undefined && effort === undefined && fast === undefined) continue;
    overrides[role] = { ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(fast !== undefined ? { fast } : {}) };
  }
  return overrides;
}

export const CLINE_THINKING = ["none", "low", "medium", "high", "xhigh"];

function clineThinking(value) {
  if (value === undefined) return "none";
  if (!CLINE_THINKING.includes(value)) throw new Error(`--cline-thinking must be one of ${CLINE_THINKING.join(", ")}`);
  return value;
}

export const IMPLEMENTATION_CLIS = ["cline", "codex", "claude", "opencode"];
export const PROVIDERS = ["llamacpp", "ollama", "openrouter", "opencode", "openai"];

/** --implementation-cli cline|codex|claude (+ --implementation-model / -effort / -fast for codex and claude). */
export function parseImplementation(options) {
  const worker = options.worker;
  if (worker !== undefined && !["cline", "opencode"].includes(worker)) throw new Error("--worker must be cline or opencode");
  const cli = options["implementation-cli"] ?? worker ?? "cline";
  if (!IMPLEMENTATION_CLIS.includes(cli)) throw new Error(`--implementation-cli must be one of ${IMPLEMENTATION_CLIS.join(", ")}`);
  const model = options["implementation-model"];
  const effort = options["implementation-effort"];
  if (model !== undefined && !/^[\w.:\[\]-]+$/.test(model)) throw new Error("--implementation-model is not a valid model identifier");
  if (effort !== undefined && !REASONING_EFFORTS.includes(effort)) throw new Error(`--implementation-effort must be one of ${REASONING_EFFORTS.join(", ")}`);
  return { cli, model: model ?? null, effort: effort ?? null, fast: booleanOption(options["implementation-fast"], "implementation-fast", false) };
}

export function parseLoopOptions(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key?.startsWith("--") || argv[i + 1] === undefined) throw new Error("Expected --name value");
    options[key.slice(2)] = argv[i + 1];
  }
  const provider = options.provider ?? "llamacpp";
  if (!PROVIDERS.includes(provider)) throw new Error(`--provider must be one of ${PROVIDERS.join(", ")}`);
  if (provider === "openai" && !options["provider-base-url"]) throw new Error("--provider-base-url is required for --provider openai");
  const providerApiKeyEnv = options["provider-api-key-env"] ?? "AGENT_DOCK_PROVIDER_KEY";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(providerApiKeyEnv)) throw new Error("--provider-api-key-env must be a valid environment variable name");
  registerSecretEnv(providerApiKeyEnv);
  const contextFallback = provider === "llamacpp" ? DEFAULT_LLAMACPP_CONTEXT_TOKENS : DEFAULT_CLINE_CONTEXT_TOKENS;
  const modelFallback = provider === "llamacpp" ? DEFAULT_LLAMACPP_MODEL : provider === "openrouter" ? "z-ai/glm-5.3-flash" : provider === "opencode" ? "deepseek-v4.1-flash-free" : DEFAULT_OLLAMA_MODEL;
  return {
    ...options,
    provider,
    providerBaseUrl: options["provider-base-url"] ?? null,
    providerApiKeyEnv,
    model: options.model ?? modelFallback,
    clineContextTokens: positiveInteger(options["cline-context-tokens"], "cline-context-tokens", contextFallback),
    clineMaxOutputTokens: positiveInteger(options["cline-max-output-tokens"], "cline-max-output-tokens", DEFAULT_LLAMACPP_MAX_OUTPUT_TOKENS),
    timeoutSeconds: positiveInteger(options["timeout-seconds"], "timeout-seconds", DEFAULT_TIMEOUT_SECONDS),
    solReassessment: booleanOption(options["sol-reassessment"], "sol-reassessment", true),
    // false: Cline runs with its normal tools; Node scope/HEAD checks and QA still gate every change.
    toolGuard: booleanOption(options["tool-guard"], "tool-guard", true),
    roleOverrides: parseRoleOverrides(options),
    roleBackups: parseRoleBackups(options),
    clineThinking: clineThinking(options["cline-thinking"]),
    llamacppModelsDir: options["llamacpp-models-dir"] || null,
    llamacppLauncher: options["llamacpp-launcher"] || null,
    implementation: parseImplementation(options),
    rolesFile: options["roles-file"] || null,
    tuning: parseTuning(options),
  };
}
