import { describe, expect, it } from "vitest";
import type { Project } from "@shared/types";
import { createTaskArgs, parseTaskList, syncOsSchedules, taskName, wantsOsSchedule } from "../src/main/lib/os-schedule";

const project = (id: string, schedule: Project["schedule"], over: Partial<Project> = {}) => ({ id, name: id, archived: false, schedule, ...over }) as Project;
const EXE = String.raw`C:\Users\me\AppData\Local\Agent Dock\App\AgentDock.exe`;

describe("scheduled runs while the app is closed", () => {
  it("builds a weekly per-user task that launches the app minimized", () => {
    const p = project("p 1", { enabled: true, time: "02:30", days: [5, 1, 1, 3], whenClosed: true });
    expect(taskName(p.id)).toBe("Agent Dock\\Run p_1");
    expect(createTaskArgs(p, EXE)).toEqual(["/Create", "/F", "/TN", "Agent Dock\\Run p_1", "/SC", "WEEKLY", "/D", "MON,WED,FRI", "/ST", "02:30", "/TR", `"${EXE}" --minimized --scheduled-run`]);
    expect(createTaskArgs(p, EXE)).not.toContain("/RU");
  });

  it("only wants enabled, valid schedules marked for when closed", () => {
    expect(wantsOsSchedule(project("a", { enabled: true, time: "02:00", days: [1], whenClosed: true }))).toBe(true);
    expect(wantsOsSchedule(project("b", { enabled: true, time: "02:00", days: [1] }))).toBe(false);
    expect(wantsOsSchedule(project("c", { enabled: false, time: "02:00", days: [1], whenClosed: true }))).toBe(false);
    expect(wantsOsSchedule(project("d", { enabled: true, time: "25:00", days: [1], whenClosed: true }))).toBe(false);
    expect(wantsOsSchedule(project("e", { enabled: true, time: "02:00", days: [], whenClosed: true }))).toBe(false);
    expect(wantsOsSchedule(project("f", { enabled: true, time: "02:00", days: [1], whenClosed: true }, { archived: true }))).toBe(false);
  });

  it("creates wanted tasks and removes only Agent Dock's other tasks", async () => {
    const calls: string[][] = [];
    const list = ['"\\Agent Dock\\Run keep","10/20/2026 2:00:00 AM","Ready"', '"\\Agent Dock\\Run old","N/A","Ready"', '"\\Microsoft\\Windows\\Defrag","N/A","Ready"', '"\\Agent Dock\\Run old","N/A","Ready"'].join("\r\n");
    const problems = await syncOsSchedules([project("keep", { enabled: true, time: "02:00", days: [1], whenClosed: true }), project("off", { enabled: true, time: "03:00", days: [2] })], EXE, async (args) => {
      calls.push(args);
      if (args[0] === "/Query") return list;
      return "SUCCESS";
    });
    expect(problems).toEqual([]);
    expect(parseTaskList(list)).toEqual(["Agent Dock\\Run keep", "Agent Dock\\Run old"]);
    expect(calls.map((c) => [c[0], c.includes("/TN") ? c[c.indexOf("/TN") + 1] : null])).toEqual([["/Query", null], ["/Create", "Agent Dock\\Run keep"], ["/Delete", "Agent Dock\\Run old"]]);
  });

  it("reports what Task Scheduler refused", async () => {
    const problems = await syncOsSchedules([project("p", { enabled: true, time: "02:00", days: [1], whenClosed: true })], EXE, async (args) => {
      if (args[0] === "/Create") throw new Error("ERROR: Access is denied.");
      return "";
    });
    expect(problems).toEqual(["p: ERROR: Access is denied."]);
  });
});
