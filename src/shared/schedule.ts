import type { ProjectSchedule } from "@shared/types";

// Scheduled runs: the app starts a project's automation at a set local time on chosen weekdays,
// while Agent Dock is open. A start missed by more
// than the grace period (the app was closed, or the PC off or asleep) is skipped rather than run late.

export const SCHEDULE_GRACE_MINUTES = 30;

/** "HH:MM" (24-hour) as minutes after midnight, or null. */
export function scheduleMinutes(time: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(time).trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** The slot `offset` days from `now`'s day, `at` minutes after local midnight. */
const slotOn = (now: Date, offset: number, at: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, Math.floor(at / 60), at % 60);
/** Whole minutes from `slot` to `now` (negative before it). */
const minutesLate = (now: Date, slot: Date) => Math.floor((now.getTime() - slot.getTime()) / 60_000);

/**
 * The scheduled start due now (local time), as an ISO key for "started already", or null. The grace
 * period runs past midnight: a 23:50 slot checked at 00:05 is still yesterday's slot, on time.
 */
export function dueScheduledStart(schedule: ProjectSchedule | undefined, now: Date, lastStart?: string | null): string | null {
  if (!schedule?.enabled || !schedule.days?.length) return null;
  const at = scheduleMinutes(schedule.time);
  if (at === null) return null;
  for (const offset of [0, -1]) {
    const slot = slotOn(now, offset, at), late = minutesLate(now, slot);
    if (late < 0 || late > SCHEDULE_GRACE_MINUTES || !schedule.days.includes(slot.getDay())) continue;
    return lastStart === slot.toISOString() ? null : slot.toISOString();
  }
  return null;
}

/** The latest slot (ISO) whose grace period has run out, looking back a week, or null. */
export function lastPassedSlot(schedule: ProjectSchedule | undefined, now: Date): string | null {
  if (!schedule?.enabled || !schedule.days?.length) return null;
  const at = scheduleMinutes(schedule.time);
  if (at === null) return null;
  for (let offset = 0; offset >= -7; offset--) {
    const slot = slotOn(now, offset, at);
    if (minutesLate(now, slot) > SCHEDULE_GRACE_MINUTES && schedule.days.includes(slot.getDay())) return slot.toISOString();
  }
  return null;
}

/** Plain-language summary, e.g. "Weekdays at 02:30". */
export function describeSchedule(schedule: ProjectSchedule | undefined): string {
  if (!schedule?.enabled || !schedule.days?.length || scheduleMinutes(schedule.time) === null) return "Off";
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const days = [...schedule.days].sort();
  const label = days.length === 7 ? "Every day" : days.join() === "1,2,3,4,5" ? "Weekdays" : days.join() === "0,6" ? "Weekends" : days.map((d) => names[d]).join(", ");
  return `${label} at ${schedule.time}`;
}
