import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { EngineEvent, TokenRecord } from "@shared/types";
import { readNdjsonTail } from "./json-file";

/** Role of one orchestrator invocation, from the opening line the engine writes into prompt.txt. */
export function classifyPrompt(prompt: string): TokenRecord["role"] {
  const head = prompt.slice(0, 240);
  // Checked first: role names are user text and may contain words like "QA".
  if (/^You are the implementation worker/i.test(head)) return "implementation";
  if (/^You are .{1,120}?, a custom workflow role/i.test(head)) return "custom";
  if (/^You are Resolver/i.test(head)) return "resolver";
  if (/^You are Assessment\b/i.test(head)) return "assessment";
  if (/reassessment|^You are Sol\b|Elevation|Astra/i.test(head)) return "elevation";
  if (/\bQA\b/.test(head)) return "qa";
  return "assessment";
}

/**
 * Token usage from one invocation's events.ndjson.
 * Codex `exec --json` emits `turn.completed` with usage; Claude Code `-p` emits a `result` with usage.
 * Returns null when the tool reported nothing (never invents counts).
 */
export function parseInvocationUsage(events: string): { provider: string; input: number; cached: number; output: number } | null {
  let found: { provider: string; input: number; cached: number; output: number } | null = null;
  for (const line of events.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const usage = event.usage as Record<string, number> | undefined;
    if (!usage) continue;
    if (event.type === "turn.completed") {
      found = found ?? { provider: "OpenAI · Codex", input: 0, cached: 0, output: 0 };
      found.input += usage.input_tokens ?? 0;
      found.cached += usage.cached_input_tokens ?? 0;
      found.output += usage.output_tokens ?? 0;
    } else if (event.type === "result") {
      const cacheRead = usage.cache_read_input_tokens ?? 0;
      const cacheWrite = usage.cache_creation_input_tokens ?? 0;
      found = found ?? { provider: "Anthropic · Claude Code", input: 0, cached: 0, output: 0 };
      // Report total input including cache traffic; cached is the cache-read share.
      found.input += (usage.input_tokens ?? 0) + cacheRead + cacheWrite;
      found.cached += cacheRead;
      found.output += usage.output_tokens ?? 0;
    }
  }
  return found;
}

/** Parsed invocations, keyed by folder: a finished invocation's events file no longer changes. */
const invocationCache = new Map<string, { mtimeMs: number; size: number; record: TokenRecord | null }>();

export async function readOrchestratorUsage(stateDir: string, projectId: string, sinceMs = 0): Promise<TokenRecord[]> {
  const codexDir = path.join(stateDir, "codex");
  let names: string[];
  try {
    names = await readdir(codexDir);
  } catch {
    return [];
  }
  const records: TokenRecord[] = [];
  await Promise.all(
    names.map(async (name) => {
      const dir = path.join(codexDir, name);
      try {
        const info = await stat(path.join(dir, "events.ndjson"));
        if (info.mtimeMs < sinceMs) return;
        const cached = invocationCache.get(dir);
        if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
          if (cached.record) records.push(cached.record);
          return;
        }
        const [events, prompt] = await Promise.all([
          readFile(path.join(dir, "events.ndjson"), "utf8"),
          readFile(path.join(dir, "prompt.txt"), "utf8").catch(() => ""),
        ]);
        const usage = parseInvocationUsage(events);
        if (!usage) {
          invocationCache.set(dir, { mtimeMs: info.mtimeMs, size: info.size, record: null });
          return;
        }
        const record: TokenRecord = {
          timestamp: new Date(info.mtimeMs).toISOString(),
          role: classifyPrompt(prompt),
          provider: usage.provider,
          model: null,
          input: usage.input,
          cached: usage.cached,
          output: usage.output,
          projectId,
          taskId: null,
        };
        invocationCache.set(dir, { mtimeMs: info.mtimeMs, size: info.size, record });
        records.push(record);
      } catch {
        // Invocation still running or incomplete.
      }
    }),
  );
  return records;
}

/**
 * llama.cpp metrics the engine samples for every Cline attempt (`cline-provider-metrics`). While an
 * attempt runs it writes partial samples (cumulative for that attempt, `runStartedAt` identifies
 * it); only the latest sample per attempt counts, and the final one replaces the partials.
 */
export function implementationUsage(events: EngineEvent[], projectId: string): TokenRecord[] {
  const latest = new Map<string, EngineEvent>();
  events.forEach((e, i) => {
    if (e.type !== "cline-provider-metrics" || typeof e.promptTokens !== "number") return;
    const key = typeof e.runStartedAt === "string" ? e.runStartedAt : `event-${i}`;
    const current = latest.get(key);
    // Events are in time order: a newer sample replaces a partial one; the final sample stays.
    if (!current || current.partial === true) latest.set(key, e);
  });
  return [...latest.values()].map((e) => ({
    timestamp: e.timestamp,
    role: "implementation" as const,
    provider: `${String(e.requestedProvider ?? e.provider ?? "local")} · local`,
    model: typeof e.model === "string" ? e.model : null,
    input: Number(e.promptTokens) || 0,
    cached: 0,
    output: Number(e.generatedTokens) || 0,
    projectId,
    taskId: e.taskId ?? null,
    local: true,
  }));
}

const COMPACTION_TEXT = /^auto-compact(?:ing|ed|ion-skipped)$/;

/** Cline context compaction bookkeeping (old logs: plain messages; new: cline-compaction events). Hidden from activity. */
export function isCompactionEvent(e: EngineEvent): boolean {
  return e.type === "cline-compaction" || (e.type === "cline-message" && COMPACTION_TEXT.test(String(e.message ?? e.action ?? "").trim()));
}

/** A compaction that actually happened (not "compacting" or "skipped"). */
export function isCompactionDone(e: EngineEvent): boolean {
  return e.type === "cline-compaction" ? e.phase === "completed" : e.type === "cline-message" && String(e.message ?? e.action ?? "").trim() === "auto-compacted";
}

export function countCompactions(events: EngineEvent[]): number {
  return events.filter(isCompactionDone).length;
}

export async function readActivity(stateDir: string, limit: number): Promise<EngineEvent[]> {
  return readNdjsonTail<EngineEvent>(path.join(stateDir, "activity.ndjson"), limit);
}
