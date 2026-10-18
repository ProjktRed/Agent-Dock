// Provider and CLI credentials the engine must not hand to repository code (check commands,
// worker shells). Each orchestrator CLI keeps only its own sign-in variables.
const PROVIDER_KEYS = ["AGENT_DOCK_PROVIDER_KEY", "OPENROUTER_API_KEY"];
export const CODEX_AUTH_ENV = ["OPENAI_API_KEY", "CODEX_API_KEY"];
export const CLAUDE_AUTH_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];
const extra = new Set();

/** A provider key read from a custom variable (--provider-api-key-env) is a secret too. */
export function registerSecretEnv(name) {
  if (name) extra.add(name.toUpperCase());
}

/** A copy of `env` without credentials, except the names in `keep` (case-insensitive, as on Windows). */
export function withoutSecrets(env = process.env, { keep = [] } = {}) {
  const kept = new Set(keep.map((n) => n.toUpperCase()));
  const secret = new Set([...PROVIDER_KEYS, ...CODEX_AUTH_ENV, ...CLAUDE_AUTH_ENV, ...extra].filter((n) => !kept.has(n)));
  return Object.fromEntries(Object.entries(env).filter(([name]) => !secret.has(name.toUpperCase())));
}
