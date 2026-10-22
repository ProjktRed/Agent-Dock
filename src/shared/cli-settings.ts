// CLI settings changed from the app (0.38). Codex CLI and Claude Code only: Cline, OpenCode and the
// OpenAI-compatible providers run through kadono's code and are left out for now.
//
// Per-run settings are passed to every Assessment, QA, Resolver and Elevation run and never loosen what
// Agent Dock sets: no sandbox, approval, permission, hook, network or MCP setting is on these lists. The
// engine checks them again against its own copy (engine/src/cli-run-settings.mjs).

export type RunSettingKind = "codex" | "claude";
export type RunSettingValue = string | number | boolean;
export type RunSettings = Record<string, RunSettingValue>;

export interface RunSettingDef {
  key: string;
  label: string;
  help: string;
  type: "choice" | "number" | "bool" | "model";
  choices?: string[];
  min?: number;
  max?: number;
}

export const RUN_SETTINGS: Record<RunSettingKind, RunSettingDef[]> = {
  codex: [
    { key: "model_reasoning_summary", label: "Reasoning summary", type: "choice", choices: ["auto", "concise", "detailed", "none"], help: "How much of its reasoning Codex summarizes (config model_reasoning_summary)." },
    { key: "model_verbosity", label: "Verbosity", type: "choice", choices: ["low", "medium", "high"], help: "How long Codex's answers are, on models that support it (model_verbosity)." },
    { key: "project_doc_max_bytes", label: "AGENTS.md read limit (bytes)", type: "number", min: 0, max: 1_000_000, help: "How much of the project's AGENTS.md files Codex reads (project_doc_max_bytes). 0 reads none." },
    { key: "tool_output_token_limit", label: "Tool output limit (tokens)", type: "number", min: 1_000, max: 200_000, help: "How much of one command's output Codex keeps (tool_output_token_limit)." },
    { key: "model_auto_compact_token_limit", label: "Compact context at (tokens)", type: "number", min: 10_000, max: 2_000_000, help: "Codex compacts the conversation when it reaches this many tokens (model_auto_compact_token_limit)." },
  ],
  claude: [
    { key: "fallbackModel", label: "Fallback model", type: "model", help: "The model Claude Code switches to when the chosen one is overloaded (--fallback-model), e.g. sonnet." },
    { key: "CLAUDE_CODE_MAX_OUTPUT_TOKENS", label: "Max output tokens", type: "number", min: 1_000, max: 128_000, help: "The longest answer Claude Code may write (CLAUDE_CODE_MAX_OUTPUT_TOKENS)." },
    { key: "MAX_THINKING_TOKENS", label: "Thinking tokens", type: "number", min: 0, max: 128_000, help: "Thinking budget per answer (MAX_THINKING_TOKENS). The agent's effort still applies." },
    { key: "BASH_DEFAULT_TIMEOUT_MS", label: "Command timeout (ms)", type: "number", min: 10_000, max: 3_600_000, help: "How long one command (a test run in QA) may take by default (BASH_DEFAULT_TIMEOUT_MS)." },
    { key: "BASH_MAX_TIMEOUT_MS", label: "Longest command timeout (ms)", type: "number", min: 10_000, max: 3_600_000, help: "The most Claude Code may ask for one command (BASH_MAX_TIMEOUT_MS)." },
    { key: "DISABLE_TELEMETRY", label: "No telemetry", type: "bool", help: "Claude Code sends no usage telemetry (DISABLE_TELEMETRY)." },
    { key: "DISABLE_ERROR_REPORTING", label: "No error reports", type: "bool", help: "Claude Code sends no error reports (DISABLE_ERROR_REPORTING)." },
  ],
};

const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:\-[\]]{0,79}$/;

/** The settings that are on the list and valid; anything else is dropped, so a stored value never reaches a CLI unchecked. */
export function cleanRunSettings(kind: RunSettingKind, raw: unknown): RunSettings {
  const out: RunSettings = {};
  if (!raw || typeof raw !== "object") return out;
  for (const def of RUN_SETTINGS[kind]) {
    const value = (raw as Record<string, unknown>)[def.key];
    if (value === undefined || value === null || value === "") continue;
    if (def.type === "choice" && typeof value === "string" && def.choices!.includes(value)) out[def.key] = value;
    if (def.type === "model" && typeof value === "string" && MODEL.test(value.trim())) out[def.key] = value.trim();
    if (def.type === "bool" && value === true) out[def.key] = true;
    if (def.type === "number") {
      const n = typeof value === "number" ? value : Number(value);
      if (Number.isInteger(n) && n >= def.min! && n <= def.max!) out[def.key] = n;
    }
  }
  return out;
}

// Ollama's own server settings: environment variables Ollama reads when it starts (Windows: your user
// environment). Agent Dock never starts Ollama, so these touch no engine code. OLLAMA_HOST is left out:
// the connection's address says where Ollama listens.
export interface OllamaSettingDef {
  key: string;
  label: string;
  help: string;
  type: "number" | "choice" | "bool" | "duration" | "path";
  choices?: string[];
  min?: number;
  max?: number;
}

export const OLLAMA_SETTINGS: OllamaSettingDef[] = [
  { key: "OLLAMA_NUM_PARALLEL", label: "Requests at once", type: "number", min: 1, max: 16, help: "How many requests Ollama answers at the same time. Parallel tasks on Ollama run at most this many at once." },
  { key: "OLLAMA_CONTEXT_LENGTH", label: "Default context length", type: "number", min: 2_048, max: 1_048_576, help: "Context window for models that do not set one. Each request at once needs its own share of memory." },
  { key: "OLLAMA_KV_CACHE_TYPE", label: "KV cache type", type: "choice", choices: ["f16", "q8_0", "q4_0"], help: "q8_0 halves the context's memory with little loss; needs flash attention." },
  { key: "OLLAMA_FLASH_ATTENTION", label: "Flash attention", type: "bool", help: "Less memory for long contexts on GPUs that support it." },
  { key: "OLLAMA_KEEP_ALIVE", label: "Keep model loaded", type: "duration", help: "How long a model stays in memory after its last request, e.g. 5m, 1h, or -1 for always." },
  { key: "OLLAMA_MAX_LOADED_MODELS", label: "Models loaded at once", type: "number", min: 1, max: 8, help: "How many different models Ollama keeps loaded together." },
  { key: "OLLAMA_MODELS", label: "Models folder", type: "path", help: "Where Ollama keeps its models. Ollama's own settings window can override this." },
];

/** A valid Ollama setting value as text (what the environment holds), or null when it is not valid. */
export function ollamaValue(def: OllamaSettingDef, value: string): string | null {
  const v = value.trim();
  if (def.type === "number") return /^\d+$/.test(v) && Number(v) >= def.min! && Number(v) <= def.max! ? String(Number(v)) : null;
  if (def.type === "choice") return def.choices!.includes(v) ? v : null;
  if (def.type === "bool") return v === "1" || v === "0" ? v : null;
  if (def.type === "duration") return /^(-1|0|\d{1,6}(ms|s|m|h)?)$/.test(v) ? v : null;
  // A folder: an absolute path without quotes or control characters.
  return /^(?:[A-Za-z]:[\\/]|\/)[^"\0-\x1f]{0,400}$/.test(v) ? v : null;
}

/** A CLI's own config file as read (Codex config.toml, Claude Code settings.json). */
export interface ConfigFile {
  kind: RunSettingKind;
  path: string;
  exists: boolean;
  text: string;
  /** Last change as read; a save with another value is refused (the file changed meanwhile). */
  mtimeMs: number | null;
}

export interface OllamaSettingsState {
  /** Writing is Windows only; elsewhere Ollama's service holds its settings (systemd, launchctl). */
  editable: boolean;
  /** Your user environment's values (null when not set). */
  saved: Record<string, string | null>;
  /** What the running Ollama started with, from its server.log; null when there is no log to read. */
  running: { values: Record<string, string>; at: string | null } | null;
}
