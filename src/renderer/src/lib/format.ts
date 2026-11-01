import type { ConnectionState, ProjectStatus, RunState } from "@shared/types";

/** The UI is in English, so dates and numbers are too, whatever the Windows region. */
const LOCALE = "en-US";

/** A whole count with thousands separators: 98,304. */
export function num(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString(LOCALE);
}

/** "1 skill", "2 skills"; `many` for irregular plurals ("branch" → "branches"). */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** An engine status word in sentence case: "NOT RUN" → "Not run", "not_run" → "Not run". Mixed-case text stays as it is. */
export function sentenceCase(value: string): string {
  if (/[a-z]/.test(value) && /[A-Z]/.test(value)) return value;
  return value.replace(/[_]+/g, " ").toLowerCase().replace(/^./, (c) => c.toUpperCase());
}

/** Oct 20 */
export function shortDate(when: string | number | Date): string {
  return new Date(when).toLocaleDateString(LOCALE, { month: "short", day: "numeric" });
}

/** Oct 20, 2026 */
export function longDate(when: string | number | Date): string {
  return new Date(when).toLocaleDateString(LOCALE, { month: "short", day: "numeric", year: "numeric" });
}

/** Oct 20, 2026, 14:05 */
export function dateTime(when: string | number | Date): string {
  return new Date(when).toLocaleString(LOCALE, { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}

/** 14:05 */
export function hourMinute(when: string | number | Date): string {
  return new Date(when).toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}

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
  return shortDate(iso);
}

export function clock(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString(LOCALE, { hourCycle: "h23", hour: "2-digit", minute: "2-digit", second: "2-digit" });
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

/**
 * A finished run (Overview's header and Progress): the engine is not running, nothing was interrupted
 * mid-step, and it either reported "Objective complete" or stopped/idled with every plan item checked.
 * Attention, blocked, paused and waiting states never count.
 */
export function runFinished(s: Pick<ProjectStatus, "processAlive" | "runState" | "plan" | "interrupted">): boolean {
  if (s.processAlive || s.interrupted) return false;
  const planDone = s.plan.total > 0 && s.plan.completed >= s.plan.total;
  return s.runState === "complete" || (planDone && (s.runState === "idle" || s.runState === "stopped"));
}

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
  custom: "Workflow role",
};

export function uid(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
}

/** The engine's stage ids in words. */
const STAGE_LABELS: Record<string, string> = {
  waiting: "Waiting",
  "current-task": "Assessment",
  implementing: "Implementation",
  implemented: "Implementation finished",
  qa: "QA",
  // Names from before 0.32, in older run state.
  "cline-working": "Implementation",
  "cline-complete": "Implementation finished",
  "codex-qa": "QA",
  fail: "QA failed",
  retry: "Correction",
  pass: "QA passed",
  complete: "Plan complete",
  elevating: "Elevation",
  resolving: "Resolver",
  USER_ATTENTION: "Needs your attention",
  BLOCKED: "Blocked",
  WAITING_FOR_LIMIT: "Waiting for usage limit",
  WAITING_FOR_CODEX: "Waiting for usage limit",
  paused: "Paused",
  stopped: "Stopped",
  "manual-review": "Manual review",
};

export function engineStageLabel(stage: string | null | undefined): string {
  if (!stage) return "—";
  return STAGE_LABELS[stage] ?? stage.replace(/[-_]+/g, " ").toLowerCase().replace(/^./, (c) => c.toUpperCase());
}

/** Changed files in the working tree: all of them, though the status lists only the first ones. */
export function changedCount(git: { changedFiles: unknown[]; changedTotal?: number }): number {
  return git.changedTotal ?? git.changedFiles.length;
}
