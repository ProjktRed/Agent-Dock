import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { removeLinuxSchedules, serviceExe, unitName, userUnitDir } from "../src/main/lib/linux-schedule";

const EXE = "/home/me/Apps/Agent Dock-0.38.0.AppImage";

describe("removing the systemd user timers of earlier versions", () => {
  it("reads the program a service starts, and where user units live", () => {
    expect(serviceExe(`ExecStart="${EXE}" --minimized --scheduled-run`)).toBe(EXE);
    expect(serviceExe('ExecStart="/a/100%%/$$HOME/\\"x\\"" --x')).toBe('/a/100%/$HOME/"x"');
    expect(userUnitDir("/home/me", {})).toBe(path.join("/home/me", ".config", "systemd", "user"));
    expect(userUnitDir("/home/me", { XDG_CONFIG_HOME: "/cfg" })).toBe(path.join("/cfg", "systemd", "user"));
  });

  it("disables and deletes ours, leaves another copy's alone, and does nothing when there are none", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "systemd-user-"));
    const calls: string[] = [];
    const run = async (args: string[]) => { calls.push(args.join(" ")); return ""; };
    writeFileSync(path.join(dir, `${unitName("p1")}.timer`), "x");
    writeFileSync(path.join(dir, `${unitName("p1")}.service`), `ExecStart="${EXE}" --minimized --scheduled-run`);
    writeFileSync(path.join(dir, `${unitName("gone")}.timer`), "x");
    writeFileSync(path.join(dir, `${unitName("gone")}.service`), 'ExecStart="/old/Agent Dock.AppImage" --minimized --scheduled-run');
    writeFileSync(path.join(dir, `${unitName("theirs")}.timer`), "x");
    writeFileSync(path.join(dir, `${unitName("theirs")}.service`), 'ExecStart="/opt/Other.AppImage" --minimized --scheduled-run');
    writeFileSync(path.join(dir, "unrelated.timer"), "x");
    expect(await removeLinuxSchedules(EXE, { dir, run, exists: (f) => f === "/opt/Other.AppImage" })).toEqual([]);
    expect(readdirSync(dir).sort()).toEqual([`${unitName("theirs")}.service`, `${unitName("theirs")}.timer`, "unrelated.timer"]);
    expect(calls.slice(0, 2).sort()).toEqual([`disable --now ${unitName("gone")}.timer`, `disable --now ${unitName("p1")}.timer`]);
    expect(calls.slice(2)).toEqual(["daemon-reload"]);
    calls.length = 0;
    expect(await removeLinuxSchedules(EXE, { dir, run, exists: (f) => f === "/opt/Other.AppImage" })).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("reports a systemd failure instead of throwing", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "systemd-user-"));
    writeFileSync(path.join(dir, `${unitName("p1")}.timer`), "x");
    const problems = await removeLinuxSchedules(EXE, { dir, run: async () => { throw new Error("Failed to connect to bus"); } });
    expect(problems).toEqual(["systemd: Failed to connect to bus"]);
  });
});
