import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { shellLine, stopAndClean } from "./proc";
import type { ModelCatalog, ProviderModels } from "@shared/types";
import { claudeFastPending, parseClaudeModels, parseCodexModels, type CodexModelListResult } from "./lib/models-parse";
import { readJson, writeJson } from "./lib/json-file";

const quote = (p: string) => (/[\s&()]/.test(p) && !p.startsWith('"') ? `"${p}"` : p);
/** One argument for a `shell: true` spawn on Windows (cmd → MSVC argv rules). */
const winArg = (value: string) => `"${value.replace(/"/g, '\\"')}"`;
const failed = (provider: ProviderModels["provider"], source: string, error: string): ProviderModels => ({
  provider,
  ok: false,
  fetchedAt: new Date().toISOString(),
  source,
  models: [],
  fastBlockedReason: null,
  error,
});

/** Line-delimited JSON from a child's stdout. */
function onJsonLines(stream: NodeJS.ReadableStream, handle: (message: any) => void) {
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      try {
        handle(JSON.parse(line));
      } catch {
        // not JSON (banner, warning): ignore
      }
    }
  });
}

/** Codex: app-server `model/list` (read-only, no usage cost), following pagination. */
export function readCodexModels(codexPath: string, timeoutMs = 30_000): Promise<ProviderModels> {
  const source = "Codex app-server · model/list";
  return new Promise((resolve) => {
    const child = spawn(shellLine(quote(codexPath), ["app-server"]), { shell: true, windowsHide: true });
    const data: CodexModelListResult["data"] = [];
    let stderr = "";
    let done = false;
    let nextId = 2;
    const finish = (value: ProviderModels) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.stdin.end();
      child.kill();
      resolve(value);
    };
    const timer = setTimeout(() => finish(failed("codex", source, "Timed out waiting for codex app-server")), timeoutMs);
    const send = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const list = (cursor?: string) => send({ id: nextId++, method: "model/list", params: { includeHidden: false, ...(cursor ? { cursor } : {}) } });
    child.on("error", (error) => finish(failed("codex", source, error.message)));
    child.on("close", (code) => finish(failed("codex", source, stderr.trim().split(/\r?\n/).pop() || `codex app-server exited with ${code}`)));
    child.stderr.on("data", (d) => (stderr += d));
    onJsonLines(child.stdout, (message) => {
      if (message.id === 1) {
        if (message.error) return finish(failed("codex", source, message.error.message ?? "initialize failed"));
        send({ method: "initialized" });
        list();
      } else if (typeof message.id === "number" && message.id >= 2) {
        if (message.error) return finish(failed("codex", source, message.error.message ?? "model/list failed"));
        const result = message.result as CodexModelListResult;
        data.push(...(result.data ?? []));
        if (result.nextCursor && nextId < 12) list(result.nextCursor);
        else finish(parseCodexModels({ data }));
      }
    });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "agent-dock", title: "Agent Dock", version: "1" } } });
  });
}

/**
 * Claude Code: the SDK `initialize` control request returns the models the account can use, with
 * their effort levels and fast-mode support. No prompt is sent (free). The fastMode flag setting
 * makes it report whether fast mode is actually available; hooks are off so none run.
 */
export async function readClaudeModels(claudePath: string, attempts = 3): Promise<ProviderModels> {
  let result = await readClaudeModelsOnce(claudePath);
  while (result.pending && --attempts > 0) {
    await new Promise((r) => setTimeout(r, 4000));
    result = await readClaudeModelsOnce(claudePath);
  }
  return result.models;
}

function readClaudeModelsOnce(claudePath: string, timeoutMs = 45_000): Promise<{ models: ProviderModels; pending: boolean }> {
  const source = "Claude Code · initialize (models)";
  const cwd = mkdtempSync(path.join(os.tmpdir(), "agent-dock-claude-"));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("CLAUDE")));
  const settings = winArg(JSON.stringify({ fastMode: true, disableAllHooks: true }));
  const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--strict-mcp-config", "--setting-sources", "user", "--settings", settings];
  return new Promise((resolve) => {
    const child = spawn(shellLine(quote(claudePath), args), { shell: true, windowsHide: true, cwd, env });
    let stderr = "";
    let done = false;
    const finish = (value: ProviderModels, pending = false) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stopAndClean(child, cwd);
      resolve({ models: value, pending });
    };
    const timer = setTimeout(() => finish(failed("claude", source, "Timed out waiting for Claude Code")), timeoutMs);
    child.on("error", (error) => finish(failed("claude", source, error.message)));
    child.on("close", () => finish(failed("claude", source, /not logged in|login|auth/i.test(stderr) ? "Claude Code is not signed in" : stderr.trim().split(/\r?\n/).pop() || "Claude Code exited without listing models")));
    child.stderr.on("data", (d) => (stderr += d));
    onJsonLines(child.stdout, (message) => {
      if (message.type !== "control_response" || message.response?.request_id !== "agent-dock-init") return;
      if (message.response.subtype !== "success") return finish(failed("claude", source, message.response.error ?? "initialize failed"));
      const response = message.response.response ?? {};
      finish(parseClaudeModels(response), claudeFastPending(response));
    });
    child.stdin.write(`${JSON.stringify({ type: "control_request", request_id: "agent-dock-init", request: { subtype: "initialize" } })}\n`);
  });
}

/** Caches the model list per orchestrator CLI; refreshed on launch and on demand. */
export class ModelsService {
  state: ModelCatalog = { codex: null, claude: null, refreshing: { codex: false, claude: false } };

  constructor(
    private readonly cacheFile: string,
    private readonly resolveCli: (kind: "codex" | "claude") => Promise<string | null>,
    private readonly emit: (state: ModelCatalog) => void,
  ) {}

  async load() {
    const cached = await readJson<Partial<ModelCatalog>>(this.cacheFile, {});
    this.state = { codex: cached.codex ?? null, claude: cached.claude ?? null, refreshing: { codex: false, claude: false } };
  }

  async refresh(provider: "codex" | "claude"): Promise<ModelCatalog> {
    if (this.state.refreshing[provider]) return this.state;
    this.state = { ...this.state, refreshing: { ...this.state.refreshing, [provider]: true } };
    this.emit(this.state);
    const name = provider === "codex" ? "Codex CLI" : "Claude Code";
    const cli = await this.resolveCli(provider);
    const result = !cli ? failed(provider, name, `${name} not found`) : provider === "codex" ? await readCodexModels(cli) : await readClaudeModels(cli);
    // Keep the last good list when a refresh fails; record the error on it.
    const previous = this.state[provider];
    const next = result.ok || !previous?.ok ? result : { ...previous, error: `Refresh failed: ${result.error}` };
    this.state = { ...this.state, [provider]: next, refreshing: { ...this.state.refreshing, [provider]: false } };
    this.emit(this.state);
    await writeJson(this.cacheFile, { codex: this.state.codex, claude: this.state.claude });
    return this.state;
  }

  /** Refresh lists older than maxAgeMs (or missing). */
  async refreshStale(maxAgeMs: number) {
    for (const provider of ["codex", "claude"] as const) {
      const current = this.state[provider];
      if (!current?.ok || Date.now() - new Date(current.fetchedAt).getTime() > maxAgeMs) await this.refresh(provider);
    }
  }
}
