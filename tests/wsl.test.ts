import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { toWslPath, wslEngineArgs, wslEnv, wslKillTree, wslLaunch } from "../src/main/lib/wsl";

describe("WSL isolation", () => {
  it("translates Windows and \\\\wsl$ paths for the distro", () => {
    expect(toWslPath(String.raw`E:\GitHub repos\app`, "Ubuntu")).toBe("/mnt/e/GitHub repos/app");
    expect(toWslPath(String.raw`\\wsl$\Ubuntu\home\me\app`, "Ubuntu")).toBe("/home/me/app");
    expect(toWslPath(String.raw`\\wsl.localhost\ubuntu\home\me`, "Ubuntu")).toBe("/home/me");
    expect(() => toWslPath(String.raw`\\wsl$\Debian\home`, "Ubuntu")).toThrow(/belongs to the WSL distro Debian/);
    expect(toWslPath("npm test", "Ubuntu")).toBe("npm test");
  });

  it("drops Windows CLI locations and translates path arguments", () => {
    const args = ["--workspace", String.raw`E:\p`, "--codex-command", String.raw`C:\Users\me\AppData\Roaming\npm\codex.cmd`, "--claude-command", "claude", "--objective", "Fix C: drive note"];
    expect(wslEngineArgs(args, "Ubuntu")).toEqual(["--workspace", "/mnt/e/p", "--claude-command", "claude", "--objective", "Fix C: drive note"]);
  });

  it("builds the wsl.exe launch and passes environment variables through WSLENV", () => {
    const launch = wslLaunch("Ubuntu", String.raw`C:\App\resources\engine\src\cli.mjs`, String.raw`C:\state\p1`, ["--state-dir", String.raw`C:\state\p1`]);
    expect(launch).toEqual({ command: "wsl.exe", args: ["-d", "Ubuntu", "--cd", "/mnt/c/state/p1", "--exec", "node", "/mnt/c/App/resources/engine/src/cli.mjs", "--state-dir", "/mnt/c/state/p1"] });
    expect(() => wslLaunch("bad name;rm", "x", String.raw`C:\s`, [])).toThrow(/distro's name/);
    expect(wslEnv("PATH/l", ["OPENAI_API_KEY", "bad-key", "OPENAI_API_KEY"])).toBe("PATH/l:OPENAI_API_KEY/u");
  });

  it("Stop now ends the engine and its processes inside the distro, and only an engine", async () => {
    const kill = wslKillTree("Ubuntu", 4242);
    expect(kill.args.slice(0, 5)).toEqual(["-d", "Ubuntu", "--exec", "sh", "-c"]);
    expect(kill.args.slice(-2)).toEqual(["agent-dock-stop", "4242"]);
    // Nothing the Windows command line or wsl.exe could rewrite: no double quote, backslash, NUL or line break.
    expect(kill.args[5]).not.toMatch(/["\\\0\r\n]/);
    expect(() => wslKillTree("Ubuntu", 1)).toThrow(/process id/);
    expect(() => wslKillTree("a b", 5)).toThrow(/distro's name/);
    if (process.platform !== "linux") return;
    // On Linux (CI) the same script runs for real: a fake engine with a child, and an unrelated process.
    const dir = mkdtempSync(path.join(os.tmpdir(), "wsl-stop-"));
    const engine = path.join(dir, "cli.mjs");
    // A .mjs file is always an ES module, so the fake engine imports spawn rather than require it.
    writeFileSync(engine, `import { spawn } from "node:child_process"; spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" }); setInterval(() => {}, 1000);`);
    const parent = spawn(process.execPath, [engine], { stdio: "ignore" });
    const other = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 800));
    const childPid = Number(execFileSync("pgrep", ["-P", String(parent.pid)], { encoding: "utf8" }).trim().split("\n")[0]);
    const script = kill.args[5];
    const runScript = (pid: number) => spawnSync("sh", ["-c", script, "agent-dock-stop", String(pid)]);
    expect(runScript(other.pid!).status).toBe(3);
    expect(runScript(parent.pid!).status).toBe(0);
    await new Promise((r) => setTimeout(r, 300));
    // Gone, or a zombie waiting to be reaped: either way it no longer runs.
    const alive = (pid: number) => {
      if (!existsSync(`/proc/${pid}/stat`)) return false;
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
    };
    expect([alive(parent.pid!), alive(childPid), alive(other.pid!)]).toEqual([false, false, true]);
    other.kill("SIGKILL");
  });
});
