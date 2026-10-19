import type { ProjectSchedule } from "@shared/types";

// Scheduled runs: the app starts a project's automation at a set local time on chosen weekdays,
// while Agent Dock is open. A start missed by more than the grace period (the app was closed) is
// skipped rather than run late.

export const SCHEDULE_GRACE_MINUTES = 30;

/** "HH:MM" (24-hour) as minutes after midnight, or null. */
export function scheduleMinutes(time: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(time).trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** The scheduled start due now (local time), as an ISO key for "started already", or null. */
export function dueScheduledStart(schedule: ProjectSchedule | undefined, now: Date, lastStart?: string | null): string | null {
  if (!schedule?.enabled || !schedule.days?.includes(now.getDay())) return null;
  const at = scheduleMinutes(schedule.time);
  if (at === null) return null;
  const minutes = now.getHours() * 60 + now.getMinutes();
  if (minutes < at || minutes - at > SCHEDULE_GRACE_MINUTES) return null;
  const slot = new Date(now.getFullYear(), now.getMonth(), now.getDate(), Math.floor(at / 60), at % 60).toISOString();
  return lastStart === slot ? null : slot;
}

/** Plain-language summary, e.g. "Weekdays at 02:30". */
export function describeSchedule(schedule: ProjectSchedule | undefined): string {
  if (!schedule?.enabled || !schedule.days?.length || scheduleMinutes(schedule.time) === null) return "Off";
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const days = [...schedule.days].sort();
  const label = days.length === 7 ? "Every day" : days.join() === "1,2,3,4,5" ? "Weekdays" : days.join() === "0,6" ? "Weekends" : days.map((d) => names[d]).join(", ");
  return `${label} at ${schedule.time}`;
}
