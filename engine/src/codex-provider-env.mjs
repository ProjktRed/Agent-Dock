import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { addSecretValues, secretValuesFromEnv } from "./redact.mjs";
import { CLAUDE_AUTH_ENV, CODEX_AUTH_ENV, registerSecretEnv } from "./secret-env.mjs";

// A custom Codex model provider reads its key from the variable its config names
// (model_providers.<id>.env_key). Codex runs keep that variable, for the active provider only, read from
// the user's own config (a repository's .codex/ is refused at launch). Anything this reader doesn't
// understand keeps just Codex's own sign-in variables: inline tables, escapes in the strings it needs, and
// quoted provider ids containing "]" or "=".

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const NEVER = new Set(CLAUDE_AUTH_ENV);

/** One key-path segment: bare, "basic" or 'literal' (basic strings with escapes are not supported). */
const SEGMENT = /\s*(?:([A-Za-z0-9_-]+)|"([^"\\]*)"|'([^']*)')\s*/y;
function keyPath(text) {
  const parts = [];
  SEGMENT.lastIndex = 0;
  for (;;) {
    const m = SEGMENT.exec(text);
    if (!m) return null;
    parts.push(m[1] ?? m[2] ?? m[3]);
    if (SEGMENT.lastIndex === text.length) return parts;
    if (text[SEGMENT.lastIndex] !== ".") return null;
    SEGMENT.lastIndex++;
  }
}

/** A single-line string value with an optional trailing comment, else null. */
function stringValue(text) {
  const m = /^\s*(?:"([^"\\]*)"|'([^']*)')\s*(?:#.*)?$/.exec(text);
  return m ? (m[1] ?? m[2]) : null;
}

/** Index just past a closing run of 3 to 5 quotes at i (a closing """ may end with up to two quotes of content). */
function pastQuotes(text, i, quote) {
  let n = 3;
  while (n < 5 && text[i + n] === quote) n++;
  return i + n;
}

/**
 * The lines that start outside any string. TOML's four string kinds and its comments are scanned character by
 * character, so text inside a multi-line string, or quotes inside another string or a comment, never count.
 */
function codeLines(text) {
  const lines = [];
  let state = null; // null: code; '"' or "'": a one-line string; '"""' or "'''": a multi-line one; "#": a comment
  let start = 0, inCode = true, comment = -1;
  for (let i = 0; i <= text.length; i++) {
    const c = text[i];
    if (c === "\n" || i === text.length) {
      // Each line without its comment.
      if (inCode) lines.push(text.slice(start, comment >= 0 ? comment : i).replace(/\r$/, ""));
      if (state === '"' || state === "'" || state === "#") state = null; // these end with the line
      start = i + 1; inCode = state === null; comment = -1;
    } else if (state === null) {
      if (c === "#") { state = "#"; comment = i; }
      else if (text.startsWith('"""', i) || text.startsWith("'''", i)) { state = c.repeat(3); i += 2; }
      else if (c === '"' || c === "'") state = c;
    } else if (state === '"' || state === '"""') {
      if (c === "\\") { if (text[i + 1] !== "\n") i++; } // an escaped character; a line-ending backslash keeps its newline
      else if (state === '"' && c === '"') state = null;
      else if (state === '"""' && text.startsWith('"""', i)) { i = pastQuotes(text, i, '"') - 1; state = null; }
    } else if (state === "'") { if (c === "'") state = null; }
    else if (state === "'''" && text.startsWith("'''", i)) { i = pastQuotes(text, i, "'") - 1; state = null; }
  }
  return lines;
}

const SELECTING = ["profile", "model_provider", "env_key"];

/**
 * The string values of a TOML file by full key path (joined with NUL); other values are left out. `unreadable`
 * is set when a profiles or model_providers table header, or a profile, model_provider or env_key line, wasn't
 * understood: a guess could then pick another provider's variable.
 */
export function tomlStrings(text) {
  const values = new Map();
  let table = [];
  for (const raw of codeLines(text)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[[")) { table = [null]; continue; } // array tables: not read
    const header = /^\[([^\[\]]+)\]\s*(?:#.*)?$/.exec(line);
    if (line.startsWith("[")) {
      table = (header && keyPath(header[1])) ?? [null];
      // An escape in a quoted segment may spell any name.
      if (table.includes(null) && (/profiles|model_providers/.test(line) || line.includes("\\"))) values.unreadable = true;
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = keyPath(line.slice(0, eq));
    const string = stringValue(line.slice(eq + 1));
    if (key && string !== null && !table.includes(null)) { values.set([...table, ...key].join("\0"), string); continue; }
    // Unread: a selecting key, a key with an escape (it may spell one), or any other value that mentions one
    // (an inline table such as work = { model_provider = "x" }).
    const inProviders = [table[0], key?.[0]].some((part) => part === null || part === "profiles" || part === "model_providers");
    if ((key && SELECTING.includes(key.at(-1))) || (!key && line.slice(0, eq).includes("\\")) || (inProviders && line.includes("\\") && line.slice(eq + 1).includes("{")) || SELECTING.some((word) => line.includes(word))) values.unreadable = true;
  }
  return values;
}

/** The variable the active custom Codex provider reads its key from, or null. */
export function codexProviderKeyEnv({ env = process.env, read = (file) => readFileSync(file, "utf8") } = {}) {
  let text;
  try { text = read(path.join(env.CODEX_HOME || path.join(os.homedir(), ".codex"), "config.toml")); } catch { return null; }
  const values = tomlStrings(text);
  if (values.unreadable) return null;
  const profile = values.get("profile");
  const provider = (profile && values.get(["profiles", profile, "model_provider"].join("\0"))) || values.get("model_provider");
  if (!provider) return null;
  const name = values.get(["model_providers", provider, "env_key"].join("\0"));
  if (!name || !ENV_NAME.test(name) || /^AGENT_DOCK_/i.test(name) || NEVER.has(name.toUpperCase())) return null;
  return name;
}

/**
 * The variables a Codex run keeps: Codex's own sign-in variables plus the active provider's key. Read at
 * each launch (the config may change between runs). The provider's key is a secret everywhere else, and
 * its value is redacted wherever Agent Dock redacts secrets, whatever its name.
 */
export function codexAuthEnv({ env = process.env, read } = {}) {
  const name = codexProviderKeyEnv({ env, read });
  if (!name) return CODEX_AUTH_ENV;
  registerSecretEnv(name);
  addSecretValues(secretValuesFromEnv(env));
  return [...CODEX_AUTH_ENV, name];
}
