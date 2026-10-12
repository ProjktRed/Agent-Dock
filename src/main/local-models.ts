import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { CliConnection, CollectedModel, CollectedModels } from "@shared/types";

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

/**
 * llama.cpp: ask the running server. When it is not running and a models folder is set, start the
 * launcher in router mode just for the listing (no model is loaded), read /v1/models, stop it again.
 */
export async function collectLlamaCpp(conn: CliConnection, launcher: string, timeoutMs = 60_000): Promise<CollectedModels> {
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
  if (!launcher.trim()) return done([], "llama.cpp is not running and no launcher is set (Settings › Advanced › llama.cpp launcher). Start llama.cpp, then refresh.");
  if (!existsSync(launcher)) return done([], `Launcher not found: ${launcher}`);
  const child = spawn("cmd.exe", ["/d", "/c", launcher, "-ModelsDir", conn.modelsDir], { windowsHide: true, stdio: "ignore" });
  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(1000);
      if (child.exitCode !== null) return done([], `The launcher exited (code ${child.exitCode}) before llama.cpp answered. Is the port in use?`);
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
    if (child.pid && child.exitCode === null) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
  }
}
