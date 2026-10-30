import path from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

/**
 * Guard plan stage 1: the corpus that stage 5 replays through the old and the new guard. Two sources:
 * fixtures/guard-corpus.ndjson (written by hand, every adapter and tool class, checked by the tests) and, opt-in,
 * real calls a run kept with AGENT_DOCK_GUARD_CORPUS=1 (each run's guard-corpus.ndjson, already redacted).
 * collectCorpus gathers the second kind from a state folder, each distinct call once.
 *
 * Usage: node engine/src/guard/corpus.mjs collect <state folder>   (writes NDJSON to standard output)
 */
const MAX_DEPTH = 4, MAX_FILES = 10_000;

async function corpusFiles(dir, depth = 0, out = []) {
  if (depth > MAX_DEPTH || out.length >= MAX_FILES) return out;
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) await corpusFiles(file, depth + 1, out);
    else if (entry.isFile() && entry.name === "guard-corpus.ndjson") out.push(file);
  }
  return out;
}

/** Every distinct call (by adapter, tool and input) kept under a state folder. Malformed lines are skipped. */
export async function collectCorpus(stateDir) {
  const seen = new Set(), calls = [];
  for (const file of await corpusFiles(path.resolve(stateDir))) {
    for (const line of (await readFile(file, "utf8").catch(() => "")).split(/\r?\n/)) {
      let call;
      try { call = JSON.parse(line); } catch { continue; }
      if (!call || typeof call.adapter !== "string" || typeof call.tool !== "string") continue;
      const key = createHash("sha256").update(JSON.stringify([call.adapter, call.tool, call.input])).digest("hex");
      if (seen.has(key)) continue;
      seen.add(key);
      calls.push(call);
    }
  }
  return calls;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, stateDir] = process.argv.slice(2);
  if (command !== "collect" || !stateDir) { console.error("Usage: node corpus.mjs collect <state folder>"); process.exit(2); }
  for (const call of await collectCorpus(stateDir)) process.stdout.write(`${JSON.stringify(call)}\n`);
}
