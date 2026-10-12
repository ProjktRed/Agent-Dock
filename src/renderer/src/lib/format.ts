import type { ConnectionState, RunState } from "@shared/types";

export function tokens(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

export function duration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h}h ${m}m`;
  return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export function ago(iso: string | null | undefined): string {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diff)) return "—";
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function clock(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export const runTone: Record<RunState, { dot: string; text: string; live?: boolean }> = {
  running: { dot: "ok", text: "ok", live: true },
  pausing: { dot: "warn", text: "warn", live: true },
  stopping: { dot: "warn", text: "warn", live: true },
  paused: { dot: "warn", text: "warn" },
  stopped: { dot: "mut", text: "mut" },
  idle: { dot: "mut", text: "mut" },
  complete: { dot: "ok", text: "ok" },
  attention: { dot: "attn", text: "attn", live: true },
  blocked: { dot: "err", text: "err" },
  "waiting-limit": { dot: "warn", text: "warn" },
};

export const connectionMeta: Record<ConnectionState, { label: string; tone: string }> = {
  connected: { label: "Connected", tone: "ok" },
  disconnected: { label: "Disconnected", tone: "mut" },
  "auth-required": { label: "Authentication required", tone: "warn" },
  "not-found": { label: "Executable not found", tone: "err" },
  unavailable: { label: "Server unavailable", tone: "err" },
  "rate-limited": { label: "Rate limited", tone: "warn" },
  unchecked: { label: "Not checked", tone: "mut" },
  checking: { label: "Checking…", tone: "info" },
};

export const roleLabel: Record<string, string> = {
  implementation: "Implementation",
  qa: "QA",
  assessment: "Assessment",
  elevation: "Elevation",
  resolver: "Resolver",
  custom: "Custom",
};

export function uid(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
}
