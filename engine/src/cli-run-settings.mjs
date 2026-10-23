// Per-run CLI settings from the app (--cli-settings {"codex":{…},"claude":{…},"cline":{…},"opencode":{…}}):
// Codex CLI and Claude Code for every run (0.38), Cline and OpenCode for implementation (0.38.1). Only the
// settings below pass, checked again
// here: none of them is a sandbox, approval, permission, hook, network or MCP setting, so they never
// loosen what the engine sets. Same lists as the app's src/shared/cli-settings.ts.

const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:\-[\]]{0,79}$/;

export const RUN_SETTING_RULES = {
  codex: {
    model_reasoning_summary: { choices: ["auto", "concise", "detailed", "none"] },
    model_verbosity: { choices: ["low", "medium", "high"] },
    project_doc_max_bytes: { min: 0, max: 1_000_000 },
    tool_output_token_limit: { min: 1_000, max: 200_000 },
    model_auto_compact_token_limit: { min: 10_000, max: 2_000_000 },
  },
  claude: {
    fallbackModel: { model: true },
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: { min: 1_000, max: 128_000 },
    MAX_THINKING_TOKENS: { min: 0, max: 128_000 },
    BASH_DEFAULT_TIMEOUT_MS: { min: 10_000, max: 3_600_000 },
    BASH_MAX_TIMEOUT_MS: { min: 10_000, max: 3_600_000 },
    DISABLE_TELEMETRY: { bool: true },
    DISABLE_ERROR_REPORTING: { bool: true },
  },
  cline: {
    retries: { min: 1, max: 20 },
    compaction: { choices: ["agentic", "basic", "off"] },
  },
  opencode: {
    steps: { min: 5, max: 200 },
    variant: { choices: ["minimal", "low", "medium", "high", "max"] },
  },
};

const KINDS = Object.keys(RUN_SETTING_RULES);
const empty = () => Object.fromEntries(KINDS.map((kind) => [kind, {}]));

let SETTINGS = empty();

/** The listed, valid settings of one CLI; anything else is dropped. */
export function cleanRunSettings(kind, raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [key, rule] of Object.entries(RUN_SETTING_RULES[kind])) {
    const value = raw[key];
    if (value === undefined || value === null || value === "") continue;
    if (rule.choices) { if (rule.choices.includes(value)) out[key] = value; }
    else if (rule.model) { if (typeof value === "string" && MODEL.test(value.trim())) out[key] = value.trim(); }
    else if (rule.bool) { if (value === true) out[key] = true; }
    else if (Number.isInteger(value) && value >= rule.min && value <= rule.max) out[key] = value;
  }
  return out;
}

/** Reads --cli-settings once at start. A value that is not JSON stops the engine instead of running without it. */
export function setCliRunSettings(text) {
  if (text === undefined) { SETTINGS = empty(); return SETTINGS; }
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error("--cli-settings must be JSON"); }
  SETTINGS = Object.fromEntries(KINDS.map((kind) => [kind, cleanRunSettings(kind, parsed?.[kind])]));
  return SETTINGS;
}

/** Codex: one -c key=value per setting (TOML values: strings quoted, numbers as they are). */
export function codexRunArgs(settings = SETTINGS.codex) {
  return Object.entries(settings).flatMap(([key, value]) => ["-c", `${key}=${typeof value === "string" ? JSON.stringify(value) : value}`]);
}

/** Claude Code: the fallback model is a flag, left out when it is the run's own model (Claude Code refuses that). */
export function claudeRunArgs({ model = null, settings = SETTINGS.claude } = {}) {
  return settings.fallbackModel && settings.fallbackModel !== model ? ["--fallback-model", settings.fallbackModel] : [];
}

/** Claude Code: every other setting is an environment variable of the run. */
export function claudeRunEnv(settings = SETTINGS.claude) {
  return Object.fromEntries(Object.entries(settings).filter(([key]) => key !== "fallbackModel").map(([key, value]) => [key, value === true ? "1" : String(value)]));
}

/** Cline: the retries and compaction mode, or Agent Dock's defaults. */
export function clineRunOptions(settings = SETTINGS.cline) {
  return { retries: settings.retries ?? 6, compaction: settings.compaction ?? "agentic" };
}

/** OpenCode: the agent's step limit (null keeps the worker's own) and the model variant (OpenCode 2 has no --variant flag: it goes on the model as provider/model#variant). */
export function openCodeRunOptions(settings = SETTINGS.opencode) {
  return { steps: settings.steps ?? null, variant: settings.variant ?? null };
}
