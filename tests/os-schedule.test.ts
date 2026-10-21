import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Project } from "@shared/types";
import { createTask, createTaskArgs, legacyTaskArgs, parseTaskJson, startBoundary, syncOsSchedules, taskName, taskOwner, taskXml, wantsOsSchedule, withTaskXmlFile, xmlText } from "../src/main/lib/os-schedule";

// Nothing here touches the real Task Scheduler: every schtasks call goes to a mock `run`, and the task
// query is a mock too.
const project = (id: string, schedule: Project["schedule"], over: Partial<Project> = {}) => ({ id, name: id, archived: false, schedule, ...over }) as Project;
const EXE = String.raw`C:\Users\me\AppData\Local\Agent Dock\App\AgentDock.exe`;
const DEV = String.raw`E:\dev\Agent-Dock\release\win-unpacked\AgentDock.exe`;
// The task query's output: what ConvertTo-Json prints for the Agent Dock folder's tasks.
const task = (name: string, exe: string | null) => ({ name: `\\${name}`, exe });
const tasksJson = (...tasks: { name: string; exe: string | null }[]) => JSON.stringify(tasks);
// Wednesday 21 October 2026, 14:00 local time.
const NOW = new Date(2026, 9, 21, 14, 0);
/** The XML file a /Create /XML call points at, decoded (it must be UTF-16 LE with a BOM). */
const readTaskFile = (args: string[]) => {
  const bytes = readFileSync(args[args.indexOf("/XML") + 1]);
  expect([...bytes.subarray(0, 2)]).toEqual([0xff, 0xfe]);
  return bytes.subarray(2).toString("utf16le");
};
const tag = (xml: string, name: string) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml)?.[1];

describe("scheduled runs while the app is closed", () => {
  it("builds a weekly per-user task that launches the app minimized", () => {
    const p = project("p 1", { enabled: true, time: "02:30", days: [5, 1, 1, 3], whenClosed: true });
    expect(taskName(p.id)).toBe("Agent Dock\\Run p_1");
    expect(createTaskArgs(p, "C:\\t\\task.xml")).toEqual(["/Create", "/XML", "C:\\t\\task.xml", "/TN", "Agent Dock\\Run p_1", "/F"]);
    expect(legacyTaskArgs(p, EXE)).toEqual(["/Create", "/F", "/TN", "Agent Dock\\Run p_1", "/SC", "WEEKLY", "/D", "MON,WED,FRI", "/ST", "02:30", "/TR", `"${EXE}" --minimized --scheduled-run`]);
    expect(legacyTaskArgs(p, EXE)).not.toContain("/RU");
  });

  it("defines the task in XML: battery, catch-up, no time limit, one instance, same action", () => {
    const xml = taskXml(project("p1", { enabled: true, time: "02:30", days: [5, 1, 1, 3], whenClosed: true }), EXE, NOW);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-16"?>')).toBe(true);
    expect(tag(xml, "DisallowStartIfOnBatteries")).toBe("false");
    expect(tag(xml, "StopIfGoingOnBatteries")).toBe("false");
    expect(tag(xml, "StartWhenAvailable")).toBe("true");
    expect(tag(xml, "WakeToRun")).toBe("false");
    expect(tag(xml, "ExecutionTimeLimit")).toBe("PT0S");
    expect(tag(xml, "MultipleInstancesPolicy")).toBe("IgnoreNew");
    expect(tag(xml, "LogonType")).toBe("InteractiveToken");
    expect(tag(xml, "RunLevel")).toBe("LeastPrivilege");
    expect(xml).not.toMatch(/<UserId>|<Password>|HighestAvailable/);
    expect(tag(xml, "Command")).toBe(EXE);
    expect(tag(xml, "Arguments")).toBe("--minimized --scheduled-run");
    expect(tag(xml, "URI")).toBe("\\Agent Dock\\Run p1");
    expect(/<DaysOfWeek>(.*)<\/DaysOfWeek>/.exec(xml)?.[1]).toBe("<Monday /><Wednesday /><Friday />");
    // The first start is never in the past: 02:30 has gone by today, so tomorrow.
    expect(tag(xml, "StartBoundary")).toBe("2026-10-22T02:30:00");
    expect(startBoundary("23:15", NOW)).toBe("2026-10-21T23:15:00");
    expect(startBoundary("14:00", NOW)).toBe("2026-10-22T14:00:00");
    expect(tag(taskXml(project("p1", { enabled: true, time: "02:30", days: [1], whenClosed: true, wakeToRun: true }), EXE, NOW), "WakeToRun")).toBe("true");
  });

  it("escapes every value in the XML", () => {
    expect(xmlText(`a&b<c>"d"'e'\u0001\uFFFF`)).toBe("a&amp;b&lt;c&gt;&quot;d&quot;&apos;e&apos;");
    const odd = String.raw`C:\R&D <x>\Zoë's "Apps"\AgentDock.exe`;
    const xml = taskXml(project("p1", { enabled: true, time: "02:30", days: [1], whenClosed: true }, { name: "</Description><Exec>evil</Exec> & co" }), odd, NOW);
    expect(tag(xml, "Command")).toBe(String.raw`C:\R&amp;D &lt;x&gt;\Zoë&apos;s &quot;Apps&quot;\AgentDock.exe`);
    expect(xml.match(/<Exec>/g)).toHaveLength(1);
    expect(tag(xml, "Description")).toContain("&lt;/Description&gt;&lt;Exec&gt;evil&lt;/Exec&gt; &amp; co");
  });

  it("writes the XML as UTF-16 LE with a BOM in a private temp folder and deletes it afterwards", async () => {
    let seen = "";
    const text = await withTaskXmlFile("<Task>Zoë</Task>", async (file) => {
      seen = file;
      expect(path.dirname(path.dirname(file))).toBe(path.resolve(tmpdir()));
      expect(path.basename(path.dirname(file))).toMatch(/^agent-dock-task-/);
      const bytes = readFileSync(file);
      return [bytes[0], bytes[1], bytes.subarray(2).toString("utf16le")];
    });
    expect(text).toEqual([0xff, 0xfe, "<Task>Zoë</Task>"]);
    expect(existsSync(seen)).toBe(false);
    expect(existsSync(path.dirname(seen))).toBe(false);
    // Deleted on failure too.
    await expect(withTaskXmlFile("<Task />", async (file) => { seen = file; throw new Error("refused"); })).rejects.toThrow("refused");
    expect(existsSync(path.dirname(seen))).toBe(false);
  });

  it("creates the task from the XML through schtasks, with no shell", async () => {
    const calls: string[][] = [];
    let xml = "";
    const p = project("p1", { enabled: true, time: "02:30", days: [1], whenClosed: true });
    const note = await createTask(p, EXE, async (args) => { calls.push(args); xml = readTaskFile(args); return "SUCCESS"; }, () => {}, NOW);
    expect(note).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0].filter((a) => a !== calls[0][2])).toEqual(["/Create", "/XML", "/TN", "Agent Dock\\Run p1", "/F"]);
    expect(xml).toBe(taskXml(p, EXE, NOW));
    expect(existsSync(calls[0][2])).toBe(false);
  });

  it("falls back to the old weekly task when the XML is refused, and says why", async () => {
    const calls: string[][] = [];
    const logged: string[] = [];
    const p = project("p1", { enabled: true, time: "02:30", days: [1], whenClosed: true, wakeToRun: true });
    const note = await createTask(p, EXE, async (args) => {
      calls.push(args);
      if (args.includes("/XML")) throw new Error("ERROR: The task XML is malformed.");
      return "SUCCESS";
    }, (m) => logged.push(m), NOW);
    expect(calls.map((c) => c[1])).toEqual(["/XML", "/F"]);
    expect(calls[1]).toEqual(legacyTaskArgs(p, EXE));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("The task XML is malformed");
    expect(note).toMatch(/^p1: created with Task Scheduler's default settings.*wake the PC.*The task XML is malformed/);
    // A failed fallback is an error for the caller.
    await expect(createTask(p, EXE, async () => { throw new Error("ERROR: Access is denied."); }, () => {}, NOW)).rejects.toThrow("Access is denied.");
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
    const xmls: string[] = [];
    const problems = await syncOsSchedules([project("shared", on), project("moved", on), project("new", on)], EXE, async (args) => {
      calls.push(args);
      if (args.includes("/XML")) xmls.push(readTaskFile(args));
      return "SUCCESS";
    }, (file) => file === DEV, async () => list);
    expect(problems).toEqual([]);
    expect(calls.map((c) => [c[0], c.includes("/TN") ? c[c.indexOf("/TN") + 1] : null])).toEqual([["/Create", "Agent Dock\\Run moved"], ["/Create", "Agent Dock\\Run new"], ["/Delete", "Agent Dock\\Run leftover"]]);
    expect(calls.filter((c) => c[0] === "/Create").every((c) => c.includes("/XML"))).toBe(true);
    expect(xmls.map((x) => tag(x, "Command"))).toEqual([EXE, EXE]);
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
    }, () => true, async () => "", () => {});
    expect(problems).toEqual(["p: ERROR: Access is denied."]);
  });
});
