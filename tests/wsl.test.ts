import { describe, expect, it } from "vitest";
import { toWslPath, wslEngineArgs, wslEnv, wslLaunch } from "../src/main/lib/wsl";

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
});
