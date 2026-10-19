import type { CliConnection } from "@shared/types";
import { DEFAULT_CLIS, type FoundTools } from "./defaults";

export interface Probes {
  /** The command is on PATH. */
  onPath(command: string): Promise<boolean>;
  /** The URL answers with any HTTP status within a short timeout. */
  answers(url: string): Promise<boolean>;
}

const base = (location: string) => location.replace(/\/+$/, "").replace(/\/v1$/, "");

/** Whether a known connection's tool is installed or running on this computer. */
async function present(c: CliConnection, probes: Probes): Promise<boolean> {
  if (c.kind === "llamacpp") return (await probes.answers(`${base(c.location)}/health`)) || probes.onPath("llama-server");
  if (c.kind === "ollama") return (await probes.answers(`${base(c.location)}/api/version`)) || probes.onPath("ollama");
  return probes.onPath(c.location);
}

/**
 * The known connections found on this computer that are not registered yet (matched by kind).
 * A fresh install starts with only these; nothing from another machine is assumed.
 */
export async function discoverClis(registered: CliConnection[], probes: Probes): Promise<CliConnection[]> {
  const missing = DEFAULT_CLIS.filter((d) => !registered.some((c) => c.kind === d.kind));
  const found = await Promise.all(missing.map(async (d) => ((await present(d, probes).catch(() => false)) ? structuredClone(d) : null)));
  return found.filter((c): c is CliConnection => c !== null);
}

/** What the first agents can use: Codex before Claude Code for planning and QA, and Cline with a local runtime. */
export function foundTools(clis: CliConnection[]): FoundTools {
  const has = (kind: CliConnection["kind"]) => clis.some((c) => c.kind === kind);
  return {
    orchestrator: has("codex") ? "codex" : has("claude") ? "claude" : null,
    local: has("cline") ? (has("llamacpp") ? "llamacpp" : has("ollama") ? "ollama" : null) : null,
  };
}

/** Real probes: PATH lookup with `where`/`which`, and a 1.5 s HTTP request. */
export function systemProbes(whereAll: (command: string) => Promise<string[]>): Probes {
  return {
    onPath: async (command) => (await whereAll(command)).length > 0,
    answers: async (url) => {
      try {
        await fetch(url, { signal: AbortSignal.timeout(1_500) });
        return true;
      } catch {
        return false;
      }
    },
  };
}
