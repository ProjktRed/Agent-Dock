import claude from "./adapters/claude.mjs";
import cline from "./adapters/cline.mjs";
import codex from "./adapters/codex.mjs";
import opencode from "./adapters/opencode.mjs";

export const adapters = new Map([["claude", claude], ["cline", cline], ["codex", codex], ["opencode", opencode]]);

export function getAdapter(id) {
  const value = adapters.get(id);
  if (!value) throw new Error(`Unknown guard adapter: ${id}`);
  return value;
}
