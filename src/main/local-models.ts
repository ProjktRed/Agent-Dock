import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Agent, CliConnection, CollectedModel, CollectedModels, LocalContext } from "@shared/types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJson(url: string, timeoutMs: number, init: RequestInit = {}): Promise<any> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
  return response.json();
}

/** The models folder a llama.cpp launcher's settings.psd1 points into: the folder above ModelPath's folder. */
export function detectLlamaModelsDir(launcher: string): string | null {
  const settings = path.join(path.dirname(path.dirname(launcher)), "config", "settings.psd1");
  if (!existsSync(settings)) return null;
  const match = readFileSync(settings, "utf8").match(/ModelPath\s*=\s*'([^']+)'/);
  if (!match) return null;
  const root = path.dirname(path.dirname(match[1]));
  return existsSync(root) ? root : null;
}

/** /v1/models of a llama.cpp server; router mode lists every model in its folder. */
export function parseLlamaModels(body: any): CollectedModel[] {
  return (body?.data ?? []).map((m: any) => ({
    id: String(m.id),
    detail: m.source === "models_dir" ? `${m.status?.value ?? "listed"} · from models folder` : "served model",
    contextTokens: null,
    thinking: null,
  }));
}

/** Ollama /api/tags + /api/show: context length and the "thinking" capability per model. */
export async function collectOllama(base: string, timeoutMs = 8000): Promise<CollectedModels> {
  const source = "Ollama · /api/tags + /api/show";
  try {
    const tags = await getJson(`${base}/api/tags`, timeoutMs);
    const models: CollectedModel[] = [];
    for (const m of tags?.models ?? []) {
      let contextTokens: number | null = null;
      let thinking: boolean | null = null;
      try {
        const show = await getJson(`${base}/api/show`, timeoutMs, { method: "POST", body: JSON.stringify({ model: m.name }) });
        const info = show?.model_info ?? {};
        const ctx = Object.entries(info).find(([k]) => k.endsWith(".context_length"))?.[1];
        contextTokens = typeof ctx === "number" ? ctx : null;
        thinking = Array.isArray(show?.capabilities) ? show.capabilities.includes("thinking") : null;
      } catch {
        // keep the model with unknown details
      }
      const size = typeof m.size === "number" ? `${(m.size / 1024 ** 3).toFixed(1)} GB` : "";
      models.push({ id: m.name, detail: [size, contextTokens ? `${Math.round(contextTokens / 1024)}K ctx` : ""].filter(Boolean).join(" · "), contextTokens, thinking });
    }
    return { at: new Date().toISOString(), source, models, error: null };
  } catch (error) {
    return { at: new Date().toISOString(), source, models: [], error: `Ollama is not reachable at ${base} (${(error as Error).message}). Start Ollama, then refresh.` };
  }
}

/** llama-server arguments for a listing-only start: router mode over the folder, on the connection's address. */
export function llamaServerListArgs(conn: CliConnection): string[] {
  const url = new URL(conn.location);
  return ["--models-dir", conn.modelsDir ?? "", "--host", url.hostname, "--port", url.port || "80"];
}

/**
 * llama.cpp: ask the running server. When it is not running and a models folder is set, start it in
 * router mode just for the listing (no model is loaded), read /v1/models, stop it again. The launcher
 * script starts it when one is set; otherwise llama-server from PATH (`server`).
 */
export async function collectLlamaCpp(conn: CliConnection, launcher: string, timeoutMs = 60_000, server: string | null = null): Promise<CollectedModels> {
  const base = conn.location.replace(/\/$/, "");
  const root = base.replace(/\/v1$/, "");
  const source = conn.modelsDir ? `llama.cpp router · ${conn.modelsDir}` : "llama.cpp · /v1/models";
  const done = (models: CollectedModel[], error: string | null = null): CollectedModels => ({ at: new Date().toISOString(), source, models, error });
  try {
    const body = await getJson(`${base}/models`, 4000);
    const models = parseLlamaModels(body);
    const router = (body?.data ?? []).some((m: any) => m.source === "models_dir");
    if (conn.modelsDir && !router) return done(models, "The running llama.cpp server serves a single model. Stop it so the next start uses the models folder, then refresh.");
    return done(models);
  } catch {
    // not running
  }
  if (!conn.modelsDir) return done([], "llama.cpp is not running. Set the models folder so Agent Dock can ask it for the models there, or start the server and refresh.");
  if (!launcher.trim() && !server) return done([], "llama.cpp is not running and llama-server is not on PATH. Install llama.cpp (or set a launcher in Settings › Advanced), or start the server and refresh.");
  if (launcher.trim() && !existsSync(launcher)) return done([], `Launcher not found: ${launcher}`);
  const child = !launcher.trim()
    ? spawn(server!, llamaServerListArgs(conn), { cwd: path.dirname(server!), windowsHide: true, stdio: "ignore", detached: process.platform !== "win32" })
    : process.platform === "win32"
      ? spawn("cmd.exe", ["/d", "/c", launcher, "-ModelsDir", conn.modelsDir], { cwd: path.dirname(launcher), windowsHide: true, stdio: "ignore" })
      : spawn(launcher, ["-ModelsDir", conn.modelsDir], { cwd: path.dirname(launcher), stdio: "ignore", detached: true });
  child.on("error", () => { /* not executable: exitCode stays null, the wait below times out */ });
  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(1000);
      if (child.exitCode !== null) return done([], `${launcher.trim() ? "The launcher" : "llama-server"} exited (code ${child.exitCode}) before llama.cpp answered. Is the port in use?`);
      try {
        const health = await getJson(`${root}/health`, 2000);
        if (health?.status !== "ok") continue;
        return done(parseLlamaModels(await getJson(`${base}/models`, 4000)));
      } catch {
        // still starting
      }
    }
    return done([], "llama.cpp did not answer in time");
  } finally {
    // Only the process tree Agent Dock started here is stopped.
    if (child.pid && child.exitCode === null) {
      if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
      else {
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
      }
    }
  }
}

/**
 * Context occupancy from llama.cpp /slots: the prompt in the slot plus what it has generated so far.
 * An idle slot still holds its last prompt in the KV cache, so that is reported as idle usage.
 */
export function parseLlamaSlots(value: unknown, model: string | null): LocalContext {
  const slots = (Array.isArray(value) ? value : [value]).filter((s): s is Record<string, any> => Boolean(s) && typeof s === "object");
  const slot = slots.find((s) => s.is_processing) ?? slots[0];
  if (!slot || typeof slot.n_ctx !== "number") return { state: "unavailable", used: null, size: null, model, source: "llama.cpp /slots did not report a slot" };
  const prompt = Number(slot.n_prompt_tokens ?? slot.prompt_tokens ?? 0) || 0;
  const decoded = Number(slot.next_token?.[0]?.n_decoded ?? slot.n_decoded ?? 0) || 0;
  return { state: slot.is_processing ? "processing" : "idle", used: prompt + decoded || null, size: slot.n_ctx, model, source: "llama.cpp /slots" };
}

/** What occupies the Implementation agent's context right now. Only llama.cpp reports it. */
export async function readLocalContext(agent: Agent | null, clis: CliConnection[], runningModel: string | null = null, timeoutMs = 3000): Promise<LocalContext> {
  // The model the engine reports running wins: it is what the server actually has loaded.
  const model = runningModel || agent?.model || null;
  const none = (state: LocalContext["state"], source: string): LocalContext => ({ state, used: null, size: null, model, source });
  if (!agent || clis.find((c) => c.id === agent.cliId)?.kind !== "cline" || !agent.provider) return none("none", "No local Implementation agent");
  const conn = clis.find((c) => c.kind === agent.provider);
  if (agent.provider === "ollama") return none("not-reported", "Ollama does not report context occupancy");
  if (!conn) return none("unavailable", "No llama.cpp connection");
  const base = conn.location.replace(/\/+$/, "").replace(/\/v1$/, "");
  // Router mode (models folder) keeps one slot set per model.
  const url = `${base}/slots${conn.modelsDir && model ? `?model=${encodeURIComponent(model)}` : ""}`;
  try {
    return parseLlamaSlots(await getJson(url, timeoutMs), model);
  } catch (error) {
    return none("unavailable", `llama.cpp did not answer /slots (${(error as Error).message.slice(0, 120)}); it may not be running or the model is not loaded`);
  }
}
