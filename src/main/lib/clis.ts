import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import type { Capability, CliConnection, CliHealth, PathDetection } from "@shared/types";
import { run } from "./git";
import { cmdLine, resolveProgram } from "./cmd-line";

/**
 * Runs a CLI. Windows: through cmd.exe (npm shims are .cmd files, which execFile cannot start directly),
 * with the program resolved through PATH and PATHEXT and every argument escaped (cmd-line); elsewhere directly.
 */
async function runCli(location: string, args: string[], timeoutMs: number) {
  const program = location.replace(/^"(.*)"$/, "$1");
  if (process.platform !== "win32") return run(program, args, { timeoutMs });
  let line: string;
  try {
    line = cmdLine(resolveProgram(program), args);
  } catch (error) {
    return { stdout: "", stderr: (error as Error).message, code: 1 };
  }
  return run(line, [], { shell: true, timeoutMs });
}

export async function whereAll(command: string): Promise<string[]> {
  if (/[\\/]/.test(command)) return existsSync(command) ? [command] : [];
  const result = process.platform === "win32" ? await run("where", [command], { timeoutMs: 5000 }) : await run("which", ["-a", command], { timeoutMs: 5000 });
  if (result.code !== 0) return [];
  return result.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

export function firstVersion(text: string): string | null {
  return text.match(/\d+\.\d+(?:\.\d+)?(?:[-.\w]*)?/)?.[0] ?? null;
}

/** Prefer the Windows-runnable shim (.cmd/.exe) over the extensionless POSIX shim that `where` lists first. */
export function pickRunnable(paths: string[]): string | null {
  return paths.find((p) => /\.(cmd|exe|bat)$/i.test(p)) ?? paths[0] ?? null;
}

/** What the window may ask Agent Dock to find on PATH and run with --version: Git and the CLIs it connects to. */
const DETECTABLE = new Set(["git", "codex", "cline", "claude", "opencode"]);

export async function detectOnPath(command: string): Promise<PathDetection> {
  if (!DETECTABLE.has(command)) throw new Error("Only Git and the supported CLIs are detected here.");
  const paths = (await whereAll(command)).filter((p) => /\.(cmd|exe|bat)$/i.test(p) || !/\.\w+$/.test(p));
  const runnable = paths.filter((p) => /\.(cmd|exe|bat)$/i.test(p));
  const found = await Promise.all(
    (runnable.length ? runnable : paths).map(async (p) => {
      const out = await runCli(p, ["--version"], 10_000);
      return { path: p, version: out.code === 0 ? firstVersion(out.stdout + out.stderr) : null };
    }),
  );
  return { command, found };
}

const cap = (name: string, state: Capability["state"], detail: string): Capability => ({ name, state, detail });

function helpCapabilities(kind: CliConnection["kind"], help: string): Capability[] {
  const has = (flag: string) => help.includes(flag);
  const flagCap = (name: string, flag: string, missing: Capability["state"] = "unsupported") =>
    has(flag) ? cap(name, "detected", `${flag} listed in --help`) : cap(name, help ? missing : "unknown", help ? `${flag} not listed in --help` : "Help output unavailable");
  if (kind === "codex") {
    return [
      flagCap("Structured output", "--output-schema"),
      flagCap("JSON event stream", "--json"),
      flagCap("Ephemeral sessions", "--ephemeral"),
      cap("Usage quota reporting", "unknown", "Rolling-window quotas are not written to the engine's logs"),
    ];
  }
  if (kind === "claude") {
    return [
      flagCap("Structured output", "--json-schema"),
      flagCap("Tool allow/deny lists", "--allowedTools", "partial"),
      flagCap("Model selection", "--model"),
      cap("Usage quota reporting", "unknown", "Plan limits are not exposed to the engine"),
    ];
  }
  if (kind === "cline") {
    return [
      flagCap("Isolated config directory", "--config", "partial"),
      flagCap("Isolated data directory", "--data-dir", "partial"),
      cap("Token metrics", "partial", "Measured through the llama.cpp /metrics endpoint, not by Cline"),
    ];
  }
  if (kind === "opencode") {
    return [cap("Isolated config directory", "detected", "The engine supplies a per-run config directory"), cap("Guard plugin", "detected", "The engine verifies the guard plugin before running")];
  }
  return [];
}

async function fetchJson(url: string, timeoutMs: number, headers: Record<string, string> = {}): Promise<{ status: number; body: unknown; ms: number }> {
  const started = Date.now();
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // non-JSON (e.g. Prometheus text)
  }
  return { status: response.status, body, ms: Date.now() - started };
}

const stamp = () => new Date().toLocaleTimeString("en-GB", { hour12: false });

function blank(conn: CliConnection): CliHealth {
  return {
    id: conn.id,
    state: "checking",
    detail: "",
    version: null,
    resolvedPath: null,
    auth: { state: "unknown", detail: "Not checked" },
    models: [],
    contextMax: { value: null, provenance: "unavailable", source: "Not checked" },
    capabilities: [],
    latencyMs: null,
    checkedAt: new Date().toISOString(),
    log: [],
  };
}

const PROGRAM_KINDS = new Set<string>(["codex", "cline", "claude", "opencode"]);
/** Connections whose location is an address Agent Dock sends requests (and a saved key) to. */
export const URL_KINDS = new Set<string>(["ollama", "llamacpp", "openai"]);

/** Why a connection's address cannot be used: http(s) only, with no user name or password in it. */
export function connectionUrlProblem(location: string): string | null {
  let url: URL;
  try { url = new URL(location); } catch { return "The address is not a valid URL."; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "The address must start with http:// or https://.";
  if (url.username || url.password) return "The address must not contain a user name or password; enter the key in its own field.";
  return null;
}

/** The long form of a path that exists (Windows: 8.3 short names such as RUNNER~1 expanded), else the path resolved. */
const longPath = (p: string) => { try { return realpathSync.native(p); } catch { return path.resolve(p); } };
const samePath = (a: string, b: string) => {
  const [x, y] = [longPath(a), longPath(b)];
  return process.platform === "win32" || process.platform === "darwin" ? x.toLowerCase() === y.toLowerCase() : x === y;
};

/**
 * A CLI connection's program is one the user picks when it is neither the plain name (found on PATH when
 * it runs) nor a program PATH finds for that name: like the llama.cpp launcher, it runs only after the
 * user confirms it.
 */
export async function programNeedsConfirmation(conn: Pick<CliConnection, "kind" | "location">): Promise<boolean> {
  if (!PROGRAM_KINDS.has(conn.kind)) return false;
  const location = conn.location.trim().replace(/^"(.*)"$/, "$1");
  if (location === conn.kind) return false;
  return !(await whereAll(conn.kind)).some((found) => samePath(found, location));
}

async function checkExecutable(conn: CliConnection, health: CliHealth): Promise<CliHealth> {
  const timeout = conn.startupTimeoutSeconds * 1000;
  const paths = await whereAll(conn.location);
  const exe = pickRunnable(paths);
  health.log.push(`${stamp()}  where ${conn.location} → ${exe ?? "not found"}`);
  if (!exe) {
    return { ...health, state: "not-found", detail: `“${conn.location}” is not on PATH and is not an existing file.` };
  }
  health.resolvedPath = exe;
  const started = Date.now();
  const version = await runCli(exe, ["--version"], timeout);
  health.latencyMs = Date.now() - started;
  health.log.push(`${stamp()}  ${conn.location} --version → exit ${version.code} (${health.latencyMs} ms)`);
  if (version.code !== 0) {
    return { ...health, state: "disconnected", detail: (version.stderr || version.stdout).trim().slice(0, 300) || "The executable did not respond to --version." };
  }
  health.version = firstVersion(version.stdout + version.stderr);
  const help = await runCli(exe, conn.kind === "codex" ? ["exec", "--help"] : ["--help"], timeout);
  health.capabilities = helpCapabilities(conn.kind, help.code === 0 ? help.stdout + help.stderr : "");

  if (conn.kind === "codex") {
    const status = await runCli(exe, ["login", "status"], timeout);
    const text = (status.stdout + status.stderr).trim();
    health.log.push(`${stamp()}  codex login status → exit ${status.code}`);
    health.auth = status.code === 0 && /logged in/i.test(text) ? { state: "ok", detail: text.split(/\r?\n/)[0] } : { state: "required", detail: text.split(/\r?\n/)[0] || "Not signed in" };
  } else if (conn.kind === "claude") {
    const status = await runCli(exe, ["auth", "status"], timeout);
    health.log.push(`${stamp()}  claude auth status → exit ${status.code}`);
    try {
      const parsed = JSON.parse(status.stdout) as { loggedIn?: boolean; authMethod?: string; email?: string };
      health.auth = parsed.loggedIn ? { state: "ok", detail: `Signed in${parsed.authMethod ? ` · ${parsed.authMethod}` : ""}` } : { state: "required", detail: "claude auth status reports loggedIn: false" };
    } catch {
      health.auth = { state: "unknown", detail: "auth status output was not JSON" };
    }
  } else {
    health.auth = { state: "not-required", detail: "Uses the provider settings the engine writes for each run" };
  }
  health.contextMax = { value: null, provenance: "not-exposed", source: conn.kind === "cline" ? "Depends on the local provider" : "Not exposed by the CLI" };
  const state = health.auth.state === "required" ? "auth-required" : "connected";
  return { ...health, state, detail: state === "connected" ? `Responded in ${health.latencyMs} ms` : health.auth.detail };
}

async function checkOllama(conn: CliConnection, health: CliHealth): Promise<CliHealth> {
  const base = conn.location.replace(/\/$/, "");
  const timeout = conn.requestTimeoutSeconds * 1000;
  try {
    const version = await fetchJson(`${base}/api/version`, timeout);
    health.latencyMs = version.ms;
    health.version = (version.body as { version?: string })?.version ?? null;
    const tags = await fetchJson(`${base}/api/tags`, timeout);
    const models = ((tags.body as { models?: { name: string; size?: number }[] })?.models ?? []).map((m) => ({
      id: m.name,
      detail: m.size ? `${(m.size / 1e9).toFixed(1)} GB` : "",
      contextTokens: null as number | null,
    }));
    for (const model of models.slice(0, 10)) {
      try {
        const response = await fetch(`${base}/api/show`, { method: "POST", body: JSON.stringify({ model: model.id }), signal: AbortSignal.timeout(timeout) });
        const show = (await response.json()) as { model_info?: Record<string, unknown> };
        const key = Object.keys(show.model_info ?? {}).find((k) => k.endsWith(".context_length"));
        if (key) model.contextTokens = Number(show.model_info![key]) || null;
      } catch {
        // leave unknown
      }
    }
    health.models = models.map((m) => ({ ...m, detail: [m.detail, m.contextTokens ? `${Math.round(m.contextTokens / 1024)}K ctx` : ""].filter(Boolean).join(" · ") }));
    const def = models.find((m) => m.id === conn.defaultModel) ?? models[0];
    health.contextMax = def?.contextTokens
      ? { value: def.contextTokens, provenance: "reported", source: `Reported by Ollama for ${def.id}` }
      : { value: null, provenance: "not-exposed", source: "Model did not declare a context length" };
    health.auth = { state: "not-required", detail: "Local runtime" };
    health.capabilities = [
      cap("Model discovery", "detected", `/api/tags lists ${models.length} models`),
      cap("Context metadata", models.some((m) => m.contextTokens) ? "detected" : "unknown", "/api/show model_info"),
      cap("Usage quotas", "unsupported", "Not applicable to a local runtime"),
    ];
    health.log.push(`${stamp()}  GET /api/version ${version.status} (${version.ms} ms)`, `${stamp()}  GET /api/tags ${tags.status} · ${models.length} models`);
    return { ...health, state: "connected", detail: `Responded in ${version.ms} ms` };
  } catch (error) {
    health.log.push(`${stamp()}  ${base} unreachable: ${(error as Error).message}`);
    return { ...health, state: "unavailable", detail: `Server unavailable at ${base}. Is Ollama running?` };
  }
}

async function checkOpenAiCompatible(conn: CliConnection, health: CliHealth, secret: string | null): Promise<CliHealth> {
  const base = conn.location.replace(/\/$/, "");
  const root = base.replace(/\/v1$/, "");
  const timeout = conn.requestTimeoutSeconds * 1000;
  const headers: Record<string, string> = secret ? { Authorization: `Bearer ${secret}` } : {};
  try {
    if (conn.kind === "llamacpp") {
      const healthResponse = await fetchJson(`${root}/health`, timeout);
      health.log.push(`${stamp()}  GET /health ${healthResponse.status} (${healthResponse.ms} ms)`);
      health.latencyMs = healthResponse.ms;
      if ((healthResponse.body as { status?: string })?.status !== "ok") {
        return { ...health, state: "unavailable", detail: `llama.cpp /health returned ${JSON.stringify(healthResponse.body).slice(0, 120)}` };
      }
    }
    const models = await fetchJson(`${base}/models`, timeout, headers);
    health.latencyMs ??= models.ms;
    health.log.push(`${stamp()}  GET /models ${models.status} (${models.ms} ms)`);
    if (models.status === 401 || models.status === 403) {
      health.auth = { state: "required", detail: `HTTP ${models.status}: credential missing or rejected` };
      return { ...health, state: "auth-required", detail: health.auth.detail };
    }
    if (models.status === 429) return { ...health, state: "rate-limited", detail: "HTTP 429 from /models" };
    if (models.status >= 400) return { ...health, state: "disconnected", detail: `HTTP ${models.status} from /models` };
    const list = ((models.body as { data?: { id: string }[] })?.data ?? []).map((m) => ({ id: m.id, detail: "advertised by /models", contextTokens: null as number | null }));
    health.models = list;
    health.auth = secret ? { state: "ok", detail: "Stored key accepted" } : { state: "not-required", detail: "No key required" };
    health.capabilities = [cap("Model discovery", list.length ? "detected" : "partial", `/models lists ${list.length}`)];
    if (conn.kind === "llamacpp") {
      try {
        const props = await fetchJson(`${root}/props`, timeout);
        const body = props.body as { default_generation_settings?: { n_ctx?: number }; n_ctx?: number };
        const nctx = Number(body?.default_generation_settings?.n_ctx ?? body?.n_ctx) || null;
        health.contextMax = nctx ? { value: nctx, provenance: "reported", source: "Per-slot context from llama.cpp /props" } : { value: null, provenance: "not-exposed", source: "/props did not report n_ctx" };
        if (nctx && list[0]) list[0].contextTokens = nctx;
      } catch {
        health.contextMax = { value: null, provenance: "unavailable", source: "/props unreachable" };
      }
      try {
        const metrics = await fetch(`${root}/metrics`, { signal: AbortSignal.timeout(timeout) });
        health.capabilities.push(cap("Token metrics", metrics.ok ? "detected" : "unsupported", metrics.ok ? "/metrics enabled" : "Start llama-server with --metrics"));
      } catch {
        health.capabilities.push(cap("Token metrics", "unknown", "/metrics unreachable"));
      }
    } else {
      health.contextMax = { value: null, provenance: "not-exposed", source: "OpenAI-compatible /models does not report context" };
    }
    return { ...health, state: "connected", detail: `Responded in ${health.latencyMs} ms` };
  } catch (error) {
    health.log.push(`${stamp()}  ${base} unreachable: ${(error as Error).message}`);
    return { ...health, state: "unavailable", detail: `Server unavailable at ${base}` };
  }
}

export async function checkCli(conn: CliConnection, secret: string | null): Promise<CliHealth> {
  const health = blank(conn);
  try {
    if (conn.kind === "ollama") return await checkOllama(conn, health);
    if (conn.kind === "llamacpp" || conn.kind === "openai") return await checkOpenAiCompatible(conn, health, secret);
    // Only the known CLIs are programs to run; an unknown kind (an older or edited file) never starts one.
    if (!PROGRAM_KINDS.has(conn.kind)) return { ...health, state: "disconnected", detail: `Unknown kind of connection: ${String(conn.kind).slice(0, 40)}` };
    return await checkExecutable(conn, health);
  } catch (error) {
    return { ...health, state: "disconnected", detail: (error as Error).message };
  }
}
