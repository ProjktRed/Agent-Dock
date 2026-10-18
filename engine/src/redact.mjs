// Secret redaction (0.21.0). Anything the engine saves (Activity, the action log, reports) or sends
// off the machine (notifications, prompts to cloud models) passes through here first. Two layers:
// the exact values of secrets the engine was given (provider keys, notification URLs and tokens,
// secret-looking environment variables), and well-known credential formats. A redaction names the
// kind ("[redacted:github-token]") so the reader still understands what was there.

const PATTERNS = [
  ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
  ["anthropic-key", /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
  ["openai-key", /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g],
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{22,})/g],
  ["aws-key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ["google-key", /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ["slack-token", /\bxox[abposr]-[A-Za-z0-9-]{10,}/g],
  ["slack-webhook", /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/g],
  ["discord-webhook", /https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+/g],
  ["telegram-token", /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
];
// "Authorization: Bearer x", "api_key = x", "password: x": keep the name, hide the value.
const ASSIGNMENTS = [
  ["bearer-token", /(\bBearer\s+)([A-Za-z0-9._~+/=-]{16,})/g],
  ["secret", /(\b[\w-]*(?:api[_-]?key|secret|token|passw(?:or)?d|credential)s?["']?\s*[:=]\s*["']?)([^\s"',;]{8,})/gi],
];
const SECRET_NAME = /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|WEBHOOK)/i;

let values = [];

/** The exact secret values to hide everywhere (longest first, so a key inside a URL goes as a whole). */
export function useSecretValues(list = []) {
  values = [...new Set(list.map((v) => String(v ?? "").trim()).filter((v) => v.length >= 8))].sort((a, b) => b.length - a.length);
}

/** Secrets the engine process holds: secret-looking variables, and every string inside AGENT_DOCK_NOTIFY. */
export function secretValuesFromEnv(env = process.env) {
  const found = [];
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== "string" || value.length < 8) continue;
    if (name === "AGENT_DOCK_NOTIFY") {
      try { collect(JSON.parse(value), found); } catch {}
      continue;
    }
    if (SECRET_NAME.test(name) && !/^(?:AGENT_DOCK_PROTECTED_PATHS|.*_PATH|.*_DIR|.*_FILE)$/i.test(name)) found.push(value);
  }
  return found;
}
// Channel URLs, bot tokens and API keys are secrets; project names, chat IDs and addresses are not.
function collect(value, out, key = "") {
  if (typeof value === "string") { if (value.length >= 8 && /webhook|discord|slack|token|key|secret/i.test(key)) out.push(value); return; }
  if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) collect(v, out, Array.isArray(value) ? key : k);
}

/**
 * Redacts one string. patterns:false hides only the exact known values; assignments:false skips the
 * "name = value" rule, for text that contains code (prompts, diffs), where it would hide ordinary code.
 */
export function redactText(text, { patterns = true, assignments = patterns } = {}) {
  if (typeof text !== "string" || !text) return text;
  let out = text;
  for (const value of values) if (out.includes(value)) out = out.split(value).join("[redacted:secret]");
  if (!patterns) return out;
  for (const [kind, re] of PATTERNS) out = out.replace(re, `[redacted:${kind}]`);
  if (!assignments) return out;
  // Only values that look like credentials: a letter and a digit (not counts, not plain words).
  for (const [kind, re] of ASSIGNMENTS) out = out.replace(re, (match, name, secret) => (secret.startsWith("[redacted") || !/[A-Za-z]/.test(secret) || !/\d/.test(secret) ? match : `${name}[redacted:${kind}]`));
  return out;
}

/** Redacts every string in a JSON-like value (events, packets); keys and non-strings are kept. */
export function redactDeep(value, options) {
  if (typeof value === "string") return redactText(value, options);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, options));
  if (value && typeof value === "object" && value.constructor === Object) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v, options)]));
  return value;
}

// The engine process: hide the secrets it was started with.
useSecretValues(secretValuesFromEnv());
