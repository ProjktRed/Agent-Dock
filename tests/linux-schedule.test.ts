import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Project } from "@shared/types";
import { serviceExe, serviceUnit, syncLinuxSchedules, timerUnit, unitName, unitQuote, userUnitDir } from "../src/main/lib/linux-schedule";

const project = (id: string, over: Partial<Project> = {}): Project => ({
  id, name: id, path: "/p", repoUrl: null, objective: "o", description: "", createdAt: "", archived: false, stateDir: "/s", roleOverrides: {}, workflowOverrides: {},
  schedule: { enabled: true, time: "07:30", days: [3, 1, 1], whenClosed: true }, ...over,
});
const EXE = "/home/me/Apps/Agent Dock-0.38.0.AppImage";

describe("Linux scheduled runs (systemd user timers)", () => {
  it("writes a weekly persistent timer and a service that launches the AppImage", () => {
    const timer = timerUnit(project("p1"));
    expect(timer).toContain("OnCalendar=Mon,Wed *-*-* 07:30:00");
    expect(timer).toContain("Persistent=true");
    expect(timer).toContain(`Unit=${unitName("p1")}.service`);
    const service = serviceUnit(project("p1"), EXE, { DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0", HOME: "/home/me" });
    expect(service).toContain(`ExecStart="${EXE}" --minimized --scheduled-run`);
    expect(service).toContain('Environment="DISPLAY=:0"');
    expect(service).not.toContain("HOME=");
    expect(serviceExe(service)).toBe(EXE);
    expect(unitQuote('/a/100%/$HOME/"x"')).toBe('"/a/100%%/$$HOME/\\"x\\""');
    expect(serviceExe(`ExecStart=${unitQuote('/a/100%/$HOME/"x"')} --x`)).toBe('/a/100%/$HOME/"x"');
    expect(() => unitQuote("/a\nb")).toThrow(/line breaks/);
    expect(userUnitDir("/home/me", {})).toBe(path.join("/home/me", ".config", "systemd", "user"));
    expect(userUnitDir("/home/me", { XDG_CONFIG_HOME: "/cfg" })).toBe(path.join("/cfg", "systemd", "user"));
  });

  it("syncs: enables wanted timers, removes ours that are no longer wanted, leaves another copy's alone", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "systemd-user-"));
    const calls: string[] = [];
    const run = async (args: string[]) => { calls.push(args.join(" ")); return ""; };
    // Leftovers: one of ours (stale project), one from another AppImage that still exists.
    writeFileSync(path.join(dir, `${unitName("gone")}.timer`), "x");
    writeFileSync(path.join(dir, `${unitName("gone")}.service`), `ExecStart="${EXE}" --minimized --scheduled-run`);
    writeFileSync(path.join(dir, `${unitName("theirs")}.timer`), "x");
    writeFileSync(path.join(dir, `${unitName("theirs")}.service`), 'ExecStart="/opt/Other.AppImage" --minimized --scheduled-run');
    const projects = [project("p1"), project("off", { schedule: { enabled: true, time: "08:00", days: [1], whenClosed: false } }), project("theirs")];
    const problems = await syncLinuxSchedules(projects, EXE, { dir, run, env: {}, exists: (f) => f === "/opt/Other.AppImage" });
    expect(problems).toEqual([]);
    expect(readdirSync(dir).sort()).toEqual([`${unitName("p1")}.service`, `${unitName("p1")}.timer`, `${unitName("theirs")}.service`, `${unitName("theirs")}.timer`]);
    expect(readFileSync(path.join(dir, `${unitName("theirs")}.service`), "utf8")).toContain("/opt/Other.AppImage");
    expect(calls).toEqual([`disable --now ${unitName("gone")}.timer`, "daemon-reload", `enable --now ${unitName("p1")}.timer`]);
    // Nothing changed: no reload, the timer is only enabled again.
    calls.length = 0;
    await syncLinuxSchedules(projects, EXE, { dir, run, env: {}, exists: () => true });
    expect(calls).toEqual([`enable --now ${unitName("p1")}.timer`]);
  });

  it("reports a systemd failure instead of throwing", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "systemd-user-"));
    const problems = await syncLinuxSchedules([project("p1")], EXE, { dir, env: {}, run: async () => { throw new Error("Failed to connect to bus"); } });
    expect(problems).toEqual(["systemd: Failed to connect to bus"]);
  });
});
