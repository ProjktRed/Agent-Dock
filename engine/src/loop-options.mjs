export const DEFAULT_CLINE_CONTEXT_TOKENS = 98_304;
// Measured 2026-10-11 on RTX 5080 + RAM offload (--fit): fits; ~48 tok/s gen at 24K prompt, ~17 tok/s at 68K.
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

export function parseLoopOptions(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key?.startsWith("--") || argv[i + 1] === undefined) throw new Error("Expected --name value");
    options[key.slice(2)] = argv[i + 1];
  }
  const provider = options.provider ?? "llamacpp";
  const contextFallback = provider === "llamacpp" ? DEFAULT_LLAMACPP_CONTEXT_TOKENS : DEFAULT_CLINE_CONTEXT_TOKENS;
  const modelFallback = provider === "llamacpp" ? DEFAULT_LLAMACPP_MODEL : DEFAULT_OLLAMA_MODEL;
  return {
    ...options,
    provider,
    model: options.model ?? modelFallback,
    clineContextTokens: positiveInteger(options["cline-context-tokens"], "cline-context-tokens", contextFallback),
    clineMaxOutputTokens: positiveInteger(options["cline-max-output-tokens"], "cline-max-output-tokens", DEFAULT_LLAMACPP_MAX_OUTPUT_TOKENS),
    timeoutSeconds: positiveInteger(options["timeout-seconds"], "timeout-seconds", DEFAULT_TIMEOUT_SECONDS),
    solReassessment: booleanOption(options["sol-reassessment"], "sol-reassessment", true),
    // false: Cline runs with its normal tools; Node scope/HEAD checks and QA still gate every change.
    toolGuard: booleanOption(options["tool-guard"], "tool-guard", true),
  };
}
