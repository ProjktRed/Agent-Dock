import { describe, expect, it } from "vitest";
import type { Project } from "@shared/types";
import { createTaskArgs, parseTaskJson, syncOsSchedules, taskName, taskOwner, wantsOsSchedule } from "../src/main/lib/os-schedule";

const project = (id: string, schedule: Project["schedule"], over: Partial<Project> = {}) => ({ id, name: id, archived: false, schedule, ...over }) as Project;
const EXE = String.raw`C:\Users\me\AppData\Local\Agent Dock\App\AgentDock.exe`;
const DEV = String.raw`E:\dev\Agent-Dock\release\win-unpacked\AgentDock.exe`;
// The task query's output: what ConvertTo-Json prints for the Agent Dock folder's tasks.
const task = (name: string, exe: string | null) => ({ name: `\\${name}`, exe });
const tasksJson = (...tasks: { name: string; exe: string | null }[]) => JSON.stringify(tasks);

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
    const list = tasksJson(task("Agent Dock\\Run keep", EXE), task("Agent Dock\\Run old", `"${EXE}"`), task("Microsoft\\Windows\\Defrag\\ScheduledDefrag", "C:\\WINDOWS\\system32\\defrag.exe"));
    const problems = await syncOsSchedules([project("keep", { enabled: true, time: "02:00", days: [1], whenClosed: true }), project("off", { enabled: true, time: "03:00", days: [2] })], EXE, async (args) => {
      calls.push(args);
      return "SUCCESS";
    }, () => true, async () => list);
    expect(problems).toEqual([]);
    expect(parseTaskJson(list)).toEqual([{ name: "Agent Dock\\Run keep", exe: EXE }, { name: "Agent Dock\\Run old", exe: EXE }]);
    expect(calls.map((c) => [c[0], c.includes("/TN") ? c[c.indexOf("/TN") + 1] : null])).toEqual([["/Create", "Agent Dock\\Run keep"], ["/Delete", "Agent Dock\\Run old"]]);
  });

  it("reads each task's exe from the JSON, unquoted, for one task, none or several", () => {
    expect(parseTaskJson("")).toEqual([]);
    expect(parseTaskJson("[]\r\n")).toEqual([]);
    expect(parseTaskJson(JSON.stringify(task("Agent Dock\\Run a", `  "C:\\R&D\\AgentDock.exe" `)))).toEqual([{ name: "Agent Dock\\Run a", exe: "C:\\R&D\\AgentDock.exe" }]);
    const json = tasksJson(task("Agent Dock\\Run b", null), task("Agent Dock Other\\Run c", EXE), task("Agent Dock\\Sub\\Run d", EXE), task("AGENT DOCK\\Run e", EXE));
    expect(parseTaskJson(json)).toEqual([{ name: "Agent Dock\\Run b", exe: "" }, { name: "AGENT DOCK\\Run e", exe: EXE }]);
  });

  it("keeps non-ASCII exe paths intact, escaped or not", () => {
    const zoe = String.raw`C:\Users\Zoë\AppData\Local\Agent Dock\App\AgentDock.exe`;
    const raw = tasksJson(task("Agent Dock\\Run z", zoe));
    const escaped = raw.replace(/[^\x00-\x7f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
    for (const json of [raw, `\uFEFF${raw}`, escaped]) {
      const [t] = parseTaskJson(json);
      expect(t.exe).toBe(zoe);
      expect(taskOwner(t, EXE, (file) => file === zoe)).toBe("other");
    }
  });

  it("tells this install's tasks from another install's and stale ones", () => {
    const onDisk = (file: string) => file === DEV;
    expect(taskOwner({ name: "x", exe: EXE.toUpperCase().replace(/\\/g, "/") }, EXE, onDisk)).toBe("mine");
    expect(taskOwner({ name: "x", exe: DEV }, EXE, onDisk)).toBe("other");
    expect(taskOwner({ name: "x", exe: String.raw`C:\gone\AgentDock.exe` }, EXE, onDisk)).toBe("stale");
    expect(taskOwner({ name: "x", exe: "" }, EXE, onDisk)).toBe("stale");
  });

  it("leaves another install's tasks alone and takes over stale ones", async () => {
    const calls: string[][] = [];
    const gone = String.raw`C:\Old\AgentDock.exe`;
    const list = tasksJson(task("Agent Dock\\Run shared", DEV), task("Agent Dock\\Run devonly", DEV), task("Agent Dock\\Run moved", gone), task("Agent Dock\\Run leftover", gone));
    const on = { enabled: true, time: "02:00", days: [1], whenClosed: true };
    const problems = await syncOsSchedules([project("shared", on), project("moved", on), project("new", on)], EXE, async (args) => {
      calls.push(args);
      return "SUCCESS";
    }, (file) => file === DEV, async () => list);
    expect(problems).toEqual([]);
    expect(calls.map((c) => [c[0], c.includes("/TN") ? c[c.indexOf("/TN") + 1] : null])).toEqual([["/Create", "Agent Dock\\Run moved"], ["/Create", "Agent Dock\\Run new"], ["/Delete", "Agent Dock\\Run leftover"]]);
    expect(calls.filter((c) => c[0] === "/Create").every((c) => c.at(-1)!.startsWith(`"${EXE}"`))).toBe(true);
  });

  it("changes nothing when the current tasks cannot be read", async () => {
    const calls: string[][] = [];
    for (const query of [async () => { throw new Error("Access is denied."); }, async () => "not json"]) {
      const problems = await syncOsSchedules([project("p", { enabled: true, time: "02:00", days: [1], whenClosed: true })], EXE, async (args) => {
        calls.push(args);
        return "";
      }, () => true, query);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/^Reading the scheduled tasks: /);
    }
    expect(calls).toHaveLength(0);
  });

  it("reports what Task Scheduler refused", async () => {
    const problems = await syncOsSchedules([project("p", { enabled: true, time: "02:00", days: [1], whenClosed: true })], EXE, async (args) => {
      if (args[0] === "/Create") throw new Error("ERROR: Access is denied.");
      return "";
    }, () => true, async () => "");
    expect(problems).toEqual(["p: ERROR: Access is denied."]);
  });
});
