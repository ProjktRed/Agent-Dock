import type { LimitWindow, ProviderLimits } from "@shared/types";

const iso = (epochSeconds: number | null | undefined) => (epochSeconds ? new Date(epochSeconds * 1000).toISOString() : null);

export function windowLabel(minutes: number | null | undefined, fallback: string): string {
  if (!minutes) return fallback;
  if (minutes === 10_080) return "Weekly";
  if (minutes % 1440 === 0) return `${minutes / 1440}-day window`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour window`;
  return `${minutes}-minute window`;
}

interface CodexWindow {
  usedPercent: number;
  windowDurationMins?: number | null;
  resetsAt?: number | null;
}
interface CodexSnapshot {
  limitId?: string | null;
  limitName?: string | null;
  primary?: CodexWindow | null;
  secondary?: CodexWindow | null;
  credits?: { hasCredits: boolean; unlimited: boolean; balance?: string | null } | null;
  planType?: string | null;
  rateLimitReachedType?: string | null;
  spendControlReached?: boolean | null;
}
export interface CodexRateLimitsResult {
  ordinaryUsageAllowed?: boolean | null;
  rateLimits?: CodexSnapshot;
  rateLimitsByLimitId?: Record<string, CodexSnapshot> | null;
  rateLimitResetCredits?: { availableCount: number } | null;
}

/** `account/rateLimits/read` result from the Codex app-server protocol. */
export function parseCodexLimits(result: CodexRateLimitsResult, fetchedAt = new Date().toISOString()): ProviderLimits {
  const buckets = result.rateLimitsByLimitId && Object.keys(result.rateLimitsByLimitId).length ? result.rateLimitsByLimitId : { codex: result.rateLimits ?? {} };
  const windows: LimitWindow[] = [];
  let reached: string | null = null;
  let plan: string | null = null;
  let credits: CodexSnapshot["credits"] = null;
  for (const [id, b] of Object.entries(buckets)) {
    plan ??= b.planType ?? null;
    credits ??= b.credits ?? null;
    reached ??= b.rateLimitReachedType ?? (b.spendControlReached ? "spend_control_reached" : null);
    const prefix = id === "codex" ? "" : `${b.limitName ?? id} · `;
    for (const [slot, w] of [["primary", b.primary], ["secondary", b.secondary]] as const) {
      if (!w) continue;
      windows.push({
        id: `${id}:${slot}`,
        label: prefix + windowLabel(w.windowDurationMins, slot === "primary" ? "Short window" : "Long window"),
        usedPercent: w.usedPercent,
        resetsAt: iso(w.resetsAt),
        windowMinutes: w.windowDurationMins ?? null,
      });
    }
  }
  windows.sort((a, b) => (a.windowMinutes ?? 0) - (b.windowMinutes ?? 0));
  const blocked = Boolean(reached) || result.ordinaryUsageAllowed === false;
  const high = windows.some((w) => w.usedPercent >= 90);
  const extras: ProviderLimits["extras"] = [];
  if (credits) extras.push({ label: "Credits", value: credits.unlimited ? "Unlimited" : credits.hasCredits ? `Balance ${credits.balance ?? "?"}` : "None" });
  if (result.rateLimitResetCredits) extras.push({ label: "Reset credits", value: `${result.rateLimitResetCredits.availableCount} available` });
  return {
    provider: "codex",
    ok: true,
    fetchedAt,
    source: "Codex app-server · account/rateLimits/read",
    plan,
    status: blocked ? "limited" : high ? "warning" : "ok",
    statusText: blocked ? `Limited: ${(reached ?? "usage not allowed").replaceAll("_", " ")}` : high ? "Close to a limit" : "Within limits",
    windows,
    extras,
  };
}

interface ClaudeWindow {
  utilization: number;
  resetsAt?: number | null;
}
export interface ClaudeRateLimitInfo {
  status: string;
  resetsAt?: number;
  rateLimitType?: string;
  utilization?: number;
  overageStatus?: string;
  overageDisabledReason?: string;
  isUsingOverage?: boolean;
  unifiedWindows?: Record<string, ClaudeWindow>;
}

const CLAUDE_WINDOW_LABELS: Record<string, [string, number]> = {
  five_hour: ["5-hour window", 300],
  seven_day: ["Weekly", 10_080],
  seven_day_opus: ["Weekly · Opus", 10_080],
  seven_day_sonnet: ["Weekly · Sonnet", 10_080],
};

/** `rate_limit_event.rate_limit_info` from `claude -p --output-format stream-json`. */
export function parseClaudeRateLimit(info: ClaudeRateLimitInfo, fetchedAt = new Date().toISOString()): ProviderLimits {
  const source = info.unifiedWindows && Object.keys(info.unifiedWindows).length ? info.unifiedWindows : info.rateLimitType && info.utilization != null ? { [info.rateLimitType]: { utilization: info.utilization, resetsAt: info.resetsAt } } : {};
  const windows: LimitWindow[] = Object.entries(source).map(([id, w]) => {
    const [label, minutes] = CLAUDE_WINDOW_LABELS[id] ?? [id.replaceAll("_", " "), null];
    return { id, label, usedPercent: Math.round(w.utilization * 100), resetsAt: iso(w.resetsAt), windowMinutes: minutes };
  });
  windows.sort((a, b) => (a.windowMinutes ?? 99_999) - (b.windowMinutes ?? 99_999));
  const status = info.status === "rejected" ? "limited" : info.status === "allowed_warning" ? "warning" : "ok";
  const extras: ProviderLimits["extras"] = [];
  if (info.overageStatus) extras.push({ label: "Overage", value: info.isUsingOverage ? "In use" : info.overageStatus === "rejected" ? "Not available" : info.overageStatus });
  return {
    provider: "claude",
    ok: true,
    fetchedAt,
    source: "Claude Code · rate_limit_event (stream-json)",
    plan: null,
    status,
    statusText: status === "limited" ? "Limit reached" : status === "warning" ? `Warning: ${info.rateLimitType?.replaceAll("_", " ") ?? "a window"} is nearly used` : "Within limits",
    windows,
    extras,
  };
}

/** Last `rate_limit_event` in a stream-json transcript. */
export function lastRateLimitEvent(streamJson: string): ClaudeRateLimitInfo | null {
  let found: ClaudeRateLimitInfo | null = null;
  for (const line of streamJson.split(/\r?\n/)) {
    if (!line.includes("rate_limit_event")) continue;
    try {
      const event = JSON.parse(line) as { type?: string; rate_limit_info?: ClaudeRateLimitInfo };
      if (event.type === "rate_limit_event" && event.rate_limit_info) found = event.rate_limit_info;
    } catch {
      // partial line
    }
  }
  return found;
}

interface ClaudeUsageWindow {
  utilization: number | null;
  resets_at?: string | null;
  locked_reason?: string | null;
}
/** Claude Code SDK control request `get_usage` (skip_behaviors) response. */
export interface ClaudeUsageResponse {
  subscription_type?: string | null;
  rate_limits_available?: boolean;
  rate_limits?: (Record<string, unknown> & {
    extra_usage?: { is_enabled?: boolean; monthly_limit?: number | null; used_credits?: number | null; utilization?: number | null; currency?: string | null; spend_limit_reached?: boolean } | null;
    limits?: { kind: string; group?: string; percent: number; severity?: string; resets_at?: string | null; is_active?: boolean }[];
    seven_day_breakdown?: { rows?: { display_name: string; percent: number }[] } | null;
  }) | null;
}

const CLAUDE_USAGE_WINDOWS: Record<string, [string, number]> = {
  five_hour: ["5-hour window", 300],
  seven_day: ["Weekly", 10_080],
  seven_day_opus: ["Weekly · Opus", 10_080],
  seven_day_sonnet: ["Weekly · Sonnet", 10_080],
  seven_day_oauth_apps: ["Weekly · connected apps", 10_080],
  seven_day_cowork: ["Weekly · Cowork", 10_080],
};
const CLAUDE_PLANS: Record<string, string> = { free: "Claude Free", pro: "Claude Pro", max: "Claude Max", team: "Claude Team", enterprise: "Claude Enterprise" };

/** Plan limits from Claude Code's own `get_usage` (no prompt is sent). Utilization is already a percentage. */
export function parseClaudeUsage(response: ClaudeUsageResponse, fetchedAt = new Date().toISOString()): ProviderLimits {
  const limits = response.rate_limits ?? {};
  const windows: LimitWindow[] = [];
  let locked: string | null = null;
  for (const [id, [label, minutes]] of Object.entries(CLAUDE_USAGE_WINDOWS)) {
    const w = limits[id] as ClaudeUsageWindow | null | undefined;
    if (!w || typeof w.utilization !== "number") continue;
    locked ??= w.locked_reason ?? null;
    windows.push({ id, label, usedPercent: Math.round(w.utilization), resetsAt: w.resets_at ?? null, windowMinutes: minutes });
  }
  windows.sort((a, b) => (a.windowMinutes ?? 99_999) - (b.windowMinutes ?? 99_999) || a.label.localeCompare(b.label));
  const severities = (limits.limits ?? []).map((l) => l.severity ?? "normal");
  const full = windows.some((w) => w.usedPercent >= 100);
  const status = locked || full ? "limited" : severities.some((s) => s !== "normal") || windows.some((w) => w.usedPercent >= 90) ? "warning" : "ok";
  const nearest = windows.reduce<LimitWindow | null>((top, w) => (!top || w.usedPercent > top.usedPercent ? w : top), null);
  const extras: ProviderLimits["extras"] = [];
  const extra = limits.extra_usage;
  if (extra) {
    const value = !extra.is_enabled
      ? "Off"
      : extra.spend_limit_reached
        ? "Spend limit reached"
        : extra.monthly_limit != null
          ? `${extra.used_credits ?? 0} of ${extra.monthly_limit} ${extra.currency ?? ""}`.trim()
          : "On";
    extras.push({ label: "Extra usage", value });
  }
  const rows = (limits.seven_day_breakdown?.rows ?? []).filter((r) => r.percent > 0);
  if (rows.length) extras.push({ label: "This week by product", value: rows.map((r) => `${r.display_name} ${r.percent}%`).join(" · ") });
  const type = response.subscription_type ?? null;
  return {
    provider: "claude",
    ok: true,
    fetchedAt,
    source: "Claude Code · get_usage",
    plan: type ? CLAUDE_PLANS[type] ?? `Claude ${type}` : null,
    status,
    statusText: status === "limited" ? (locked ? `Limited: ${locked.replaceAll("_", " ")}` : "Limit reached") : status === "warning" ? `Warning: ${nearest?.label ?? "a window"} is ${nearest?.usedPercent ?? "?"}% used` : "Within limits",
    windows,
    extras,
  };
}
