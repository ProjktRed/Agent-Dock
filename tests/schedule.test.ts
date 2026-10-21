import { describe, expect, it } from "vitest";
import { describeSchedule, dueScheduledStart, scheduleMinutes } from "../src/shared/schedule";

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
  it("describes the schedule in plain words", () => {
    expect(describeSchedule(weekdays)).toBe("Weekdays at 02:30");
    expect(describeSchedule({ enabled: true, time: "23:05", days: [0, 1, 2, 3, 4, 5, 6] })).toBe("Every day at 23:05");
    expect(describeSchedule({ enabled: true, time: "08:00", days: [3, 1] })).toBe("Mon, Wed at 08:00");
    expect(describeSchedule(undefined)).toBe("Off");
  });
});
