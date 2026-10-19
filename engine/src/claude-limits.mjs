import path from "node:path";
import { atomicWriteJson } from "./dashboard-state.mjs";

// Claude Code reports the account's plan limits in its own stream-json output (rate_limit_event).
// The engine keeps the latest one per project in <state>/claude-rate-limit.json, so the app can show
// current limits without an extra call.

/** The last rate_limit_event's rate_limit_info in a stream-json transcript, or null. */
export function lastRateLimitInfo(stdout) {
  let found = null;
  for (const line of String(stdout ?? "").split(/\r?\n/)) {
    if (!line.includes("rate_limit_event")) continue;
    try {
      const event = JSON.parse(line);
      if (event?.type === "rate_limit_event" && event.rate_limit_info && typeof event.rate_limit_info === "object") found = event.rate_limit_info;
    } catch { /* partial line */ }
  }
  return found;
}

/** Saves the run's latest plan-limit report; never fails the run that produced it. */
export async function saveClaudeRateLimit(stateDir, stdout, now = () => new Date()) {
  const info = lastRateLimitInfo(stdout);
  if (!info) return null;
  const snapshot = { fetchedAt: now().toISOString(), info };
  await atomicWriteJson(path.join(stateDir, "claude-rate-limit.json"), snapshot).catch(() => {});
  return snapshot;
}
