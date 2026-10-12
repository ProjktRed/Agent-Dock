import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LimitsState, ProviderLimits, Settings } from "@shared/types";
import { lastRateLimitEvent, parseClaudeRateLimit, parseCodexLimits, type CodexRateLimitsResult } from "./lib/limits-parse";
import { readJson, writeJson } from "./lib/json-file";

const quote = (p: string) => (/[\s&()]/.test(p) && !p.startsWith('"') ? `"${p}"` : p);
const failed = (provider: ProviderLimits["provider"], source: string, error: string): ProviderLimits => ({
  provider,
  ok: false,
  fetchedAt: new Date().toISOString(),
  source,
  plan: null,
  status: "error",
  statusText: "Could not read limits",
  windows: [],
  extras: [],
  error,
});

/**
 * Codex: the official app-server JSON-RPC method `account/rateLimits/read` (read-only, no usage cost).
 * Only `initialize` and that read are sent; the reset-credit *consume* method is never called.
 */
export function readCodexLimits(codexPath: string, timeoutMs = 30_000): Promise<ProviderLimits> {
  const source = "Codex app-server · account/rateLimits/read";
  return new Promise((resolve) => {
    const child = spawn(quote(codexPath), ["app-server"], { shell: true, windowsHide: true });
    let buffer = "";
    let stderr = "";
    let done = false;
    const finish = (value: ProviderLimits) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.stdin.end();
      child.kill();
      resolve(value);
    };
    const timer = setTimeout(() => finish(failed("codex", source, "Timed out waiting for codex app-server")), timeoutMs);
    const send = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`);
    child.on("error", (error) => finish(failed("codex", source, error.message)));
    child.on("close", (code) => finish(failed("codex", source, stderr.trim().split(/\r?\n/).pop() || `codex app-server exited with ${code}`)));
    child.stderr.on("data", (d) => (stderr += d));
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message: { id?: number; result?: unknown; error?: { message?: string } };
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === 1) {
          if (message.error) return finish(failed("codex", source, message.error.message ?? "initialize failed"));
          send({ method: "initialized" });
          send({ id: 2, method: "account/rateLimits/read", params: { excludeResetCreditDetails: true } });
        } else if (message.id === 2) {
          if (message.error) return finish(failed("codex", source, message.error.message ?? "rate limit read failed (signed in with ChatGPT?)"));
          finish(parseCodexLimits(message.result as CodexRateLimitsResult));
        }
      }
    });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "agent-dock", title: "Agent Dock", version: "1" } } });
  });
}

/**
 * Claude Code reports plan limits only alongside a real request. One minimal, isolated request:
 * Haiku, no tools, one turn, nothing saved, run from an empty temporary folder, with CLAUDE*
 * variables stripped so it never attaches to an interactive session.
 */
export function probeClaudeLimits(claudePath: string, timeoutMs = 90_000): Promise<ProviderLimits> {
  const source = "Claude Code · rate_limit_event (stream-json)";
  const cwd = mkdtempSync(path.join(os.tmpdir(), "agent-dock-claude-"));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("CLAUDE")));
  const args = ["-p", '"Reply with the single word ok."', "--model", "haiku", "--output-format", "stream-json", "--verbose", "--max-turns", "1", "--tools", '""', "--no-session-persistence", "--strict-mcp-config", "--disable-slash-commands"];
  return new Promise((resolve) => {
    const child = spawn(quote(claudePath), args, { shell: true, windowsHide: true, cwd, env });
    let out = "";
    let err = "";
    const finish = (value: ProviderLimits) => {
      clearTimeout(timer);
      rmSync(cwd, { recursive: true, force: true });
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(failed("claude", source, "Timed out waiting for Claude Code"));
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (error) => finish(failed("claude", source, error.message)));
    child.on("close", () => {
      const info = lastRateLimitEvent(out);
      if (info) return finish(parseClaudeRateLimit(info));
      const reason = /not logged in|login|auth/i.test(out + err) ? "Claude Code is not signed in" : "Claude Code did not report plan limits (API-key accounts have no plan windows)";
      finish(failed("claude", source, reason));
    });
  });
}

/** Caches the last snapshot per provider (shown with its timestamp) and refreshes on a schedule. */
export class LimitsService {
  state: LimitsState = { codex: null, claude: null, refreshing: { codex: false, claude: false } };
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly cacheFile: string,
    private readonly resolveCli: (kind: "codex" | "claude") => Promise<string | null>,
    private readonly emit: (state: LimitsState) => void,
  ) {}

  async load() {
    const cached = await readJson<Partial<LimitsState>>(this.cacheFile, {});
    this.state = { codex: cached.codex ?? null, claude: cached.claude ?? null, refreshing: { codex: false, claude: false } };
  }

  async refresh(provider: "codex" | "claude"): Promise<LimitsState> {
    if (this.state.refreshing[provider]) return this.state;
    this.state = { ...this.state, refreshing: { ...this.state.refreshing, [provider]: true } };
    this.emit(this.state);
    const cli = await this.resolveCli(provider);
    const result = !cli
      ? failed(provider, provider === "codex" ? "Codex CLI" : "Claude Code", `${provider === "codex" ? "Codex CLI" : "Claude Code"} not found`)
      : provider === "codex"
        ? await readCodexLimits(cli)
        : await probeClaudeLimits(cli);
    // Keep the last good snapshot visible when a refresh fails; record the error on it.
    const previous = this.state[provider];
    const next = result.ok || !previous?.ok ? result : { ...previous, error: `Refresh failed: ${result.error}` };
    this.state = { ...this.state, [provider]: next, refreshing: { ...this.state.refreshing, [provider]: false } };
    this.emit(this.state);
    await writeJson(this.cacheFile, { codex: this.state.codex, claude: this.state.claude });
    return this.state;
  }

  schedule(settings: Settings) {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    const { codexPollMinutes, claudeProbeMinutes } = settings.usage;
    if (codexPollMinutes > 0) {
      void this.refresh("codex");
      this.timers.push(setInterval(() => void this.refresh("codex"), codexPollMinutes * 60_000));
    }
    if (claudeProbeMinutes > 0) {
      const stale = !this.state.claude || Date.now() - new Date(this.state.claude.fetchedAt).getTime() > claudeProbeMinutes * 60_000;
      if (stale) void this.refresh("claude");
      this.timers.push(setInterval(() => void this.refresh("claude"), claudeProbeMinutes * 60_000));
    }
  }
}
