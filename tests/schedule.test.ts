import { describe, expect, it } from "vitest";
import { describeSchedule, dueScheduledStart, lastPassedSlot, scheduleMinutes } from "../src/shared/schedule";

const weekdays = { enabled: true, time: "02:30", days: [1, 2, 3, 4, 5] };
// Monday 19 October 2026, local time.
const at = (h: number, m: number, day = 19) => new Date(2026, 9, day, h, m);

describe("scheduled runs", () => {
  it("is due once per slot, within the grace period, on chosen days only", () => {
    expect(scheduleMinutes("02:30")).toBe(150);
    expect(scheduleMinutes("24:00")).toBeNull();
    expect(dueScheduledStart(weekdays, at(2, 29))).toBeNull();
    const slot = dueScheduledStart(weekdays, at(2, 30));
    expect(slot).toBe(at(2, 30).toISOString());
    expect(dueScheduledStart(weekdays, at(2, 45), slot)).toBeNull();
    expect(dueScheduledStart(weekdays, at(3, 1))).toBeNull();
    expect(dueScheduledStart(weekdays, at(2, 31, 18))).toBeNull();
    expect(dueScheduledStart({ ...weekdays, enabled: false }, at(2, 30))).toBeNull();
  });
  it("keeps the grace period across midnight", () => {
    const monday = { enabled: true, time: "23:50", days: [1] };
    const slot = at(23, 50).toISOString();
    expect(dueScheduledStart(monday, at(23, 55))).toBe(slot);
    // Tuesday 00:05 is still Monday's 23:50 start, on time.
    expect(dueScheduledStart(monday, at(0, 5, 20))).toBe(slot);
    expect(dueScheduledStart(monday, at(0, 20, 20))).toBe(slot);
    expect(dueScheduledStart(monday, at(0, 5, 20), slot)).toBeNull();
    expect(dueScheduledStart(monday, at(0, 21, 20))).toBeNull();
    // Only the slot's own day counts: a Tuesday-only 23:50 is not due early on Tuesday.
    expect(dueScheduledStart({ ...monday, days: [2] }, at(0, 5, 20))).toBeNull();
    // Across a month end: Saturday 31 October 23:50, checked Sunday 1 November 00:05.
    expect(dueScheduledStart({ ...monday, days: [6] }, at(0, 5, 32))).toBe(new Date(2026, 9, 31, 23, 50).toISOString());
  });
  it("finds the last slot past its grace period, which a changed schedule counts as handled", () => {
    const friday = at(2, 30, 16).toISOString(), monday = at(2, 30).toISOString();
    expect(lastPassedSlot(weekdays, at(8, 0))).toBe(monday);
    // Inside the grace period it is still due, not passed.
    expect(lastPassedSlot(weekdays, at(3, 0))).toBe(friday);
    expect(dueScheduledStart(weekdays, at(3, 0), friday)).toBe(monday);
    expect(dueScheduledStart(weekdays, at(3, 1), friday)).toBeNull();
    // Over the weekend the last passed slot is Friday's.
    expect(lastPassedSlot(weekdays, at(12, 0, 18))).toBe(friday);
    expect(lastPassedSlot({ ...weekdays, enabled: false }, at(8, 0))).toBeNull();
    // Across midnight: Monday 23:50, checked Tuesday 00:30.
    expect(lastPassedSlot({ enabled: true, time: "23:50", days: [1] }, at(0, 30, 20))).toBe(at(23, 50).toISOString());
  });
  it("describes the schedule in plain words", () => {
    expect(describeSchedule(weekdays)).toBe("Weekdays at 02:30");
    expect(describeSchedule({ enabled: true, time: "23:05", days: [0, 1, 2, 3, 4, 5, 6] })).toBe("Every day at 23:05");
    expect(describeSchedule({ enabled: true, time: "08:00", days: [3, 1] })).toBe("Mon, Wed at 08:00");
    expect(describeSchedule(undefined)).toBe("Off");
  });
});
