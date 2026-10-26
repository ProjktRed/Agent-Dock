import { describe, expect, it } from "vitest";
import { parseTaskJson, removeOsSchedules, taskOwner } from "../src/main/lib/os-schedule";

// Nothing here touches the real Task Scheduler: every schtasks call goes to a mock `run`, and the task
// query is a mock too.
const EXE = String.raw`C:\Users\me\AppData\Local\Agent Dock\App\AgentDock.exe`;
const DEV = String.raw`E:\dev\Agent-Dock\release\win-unpacked\AgentDock.exe`;
// The task query's output: what ConvertTo-Json prints for the Agent Dock folder's tasks.
const task = (name: string, exe: string | null) => ({ name: `\\${name}`, exe });
const tasksJson = (...tasks: { name: string; exe: string | null }[]) => JSON.stringify(tasks);
const deleted = (calls: string[][]) => calls.map((c) => [c[0], c[c.indexOf("/TN") + 1]]);

describe("removing the scheduled-run tasks of earlier versions", () => {
  it("deletes this install's tasks and stale ones, leaves another install's and other folders alone", async () => {
    const calls: string[][] = [];
    const gone = String.raw`C:\Old\AgentDock.exe`;
    const list = tasksJson(task("Agent Dock\\Run mine", `"${EXE}"`), task("Agent Dock\\Run dev", DEV), task("Agent Dock\\Run stale", gone), task("Microsoft\\Windows\\Defrag\\ScheduledDefrag", "C:\\WINDOWS\\system32\\defrag.exe"));
    const problems = await removeOsSchedules(EXE, async (args) => { calls.push(args); return "SUCCESS"; }, (file) => file === DEV, async () => list);
    expect(problems).toEqual([]);
    expect(deleted(calls)).toEqual([["/Delete", "Agent Dock\\Run mine"], ["/Delete", "Agent Dock\\Run stale"]]);
    expect(calls.every((c) => c[0] === "/Delete")).toBe(true);
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

  it("removes nothing when the current tasks cannot be read, and reports what Task Scheduler refused", async () => {
    const calls: string[][] = [];
    for (const query of [async () => { throw new Error("Access is denied."); }, async () => "not json"]) {
      const problems = await removeOsSchedules(EXE, async (args) => { calls.push(args); return ""; }, () => true, query);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/^Reading the scheduled tasks: /);
    }
    expect(calls).toHaveLength(0);
    const refused = await removeOsSchedules(EXE, async () => { throw new Error("ERROR: Access is denied."); }, () => true, async () => tasksJson(task("Agent Dock\\Run p", EXE)));
    expect(refused).toEqual(["Removing Agent Dock\\Run p: ERROR: Access is denied."]);
  });
});
