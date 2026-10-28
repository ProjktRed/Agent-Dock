// Provider and CLI credentials the engine must not hand to repository code (check commands,
// worker shells). Each orchestrator CLI keeps only its own sign-in variables.
const PROVIDER_KEYS = ["AGENT_DOCK_PROVIDER_KEY", "OPENROUTER_API_KEY"];
// Agent Dock's own secrets: notification channels (webhook URLs, bot token, mail API key) and the Supervisor reviewer key.
const ENGINE_KEYS = ["AGENT_DOCK_NOTIFY", "AGENT_DOCK_SUPERVISOR_KEY", "AGENT_DOCK_LOG_KEY"];
export const CODEX_AUTH_ENV = ["OPENAI_API_KEY", "CODEX_API_KEY"];
export const CLAUDE_AUTH_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];
const extra = new Set();
// Any other variable named like a credential, wherever the word sits (GEMINI_API_KEY, AWS_BEARER_TOKEN_BEDROCK,
// SECRET_KEY_BASE, GITHUB_PAT, PGPASSWORD, MYSQL_PWD, REDISCLI_AUTH). Words end at an underscore, so
// TOKENIZERS_PARALLELISM, PATH, PWD and SSH_AUTH_SOCK stay.
const SECRET_WORDS = /(?:^|_)(?:API_?KEYS?|ACCESS_?KEY|PRIVATE_?KEY|SECRETS?|CREDENTIALS?|PAT)(?:_|$)|[A-Z0-9]*(?:TOKEN|PASSWORD|PASSWD|PASSPHRASE|SECRET)(?:_|$)|_(?:PWD|AUTH|AUTH_CONFIG)$/;

/** Variables that are secrets by name, whatever their length (redact.mjs hides their values). */
export const secretEnvNames = () => new Set([...PROVIDER_KEYS, ...ENGINE_KEYS, ...CODEX_AUTH_ENV, ...CLAUDE_AUTH_ENV, ...extra]);

/** A provider key read from a custom variable (--provider-api-key-env) is a secret too. */
export function registerSecretEnv(name) {
  if (name) extra.add(name.toUpperCase());
}

/**
 * A copy of `env` without credentials (listed or named like one), except the names in `keep`: any case on
 * Windows, where names are case-insensitive; the exact name elsewhere, where api_key and API_KEY are two variables.
 */
export function withoutSecrets(env = process.env, { keep = [], windows = process.platform === "win32" } = {}) {
  const kept = new Set(keep.map((n) => n.toUpperCase()));
  const exact = new Set(keep);
  const secret = new Set([...PROVIDER_KEYS, ...ENGINE_KEYS, ...CODEX_AUTH_ENV, ...CLAUDE_AUTH_ENV, ...extra]);
  return Object.fromEntries(Object.entries(env).filter(([name]) => {
    const upper = name.toUpperCase();
    if (windows ? kept.has(upper) : exact.has(name)) return true;
    return !secret.has(upper) && !SECRET_WORDS.test(upper);
  }));
}
