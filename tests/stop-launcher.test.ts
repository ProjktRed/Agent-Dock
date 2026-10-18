import { describe, expect, it } from "vitest";
import { stopLauncher } from "../src/main/lib/stop-launcher";

describe("stop-all launcher", () => {
  it("runs stop-all.mjs on the app's Node runtime with the config folder, passing extra options on", () => {
    const win = stopLauncher({ platform: "win32", execPath: "E:\\Agent Dock\\App\\Agent Dock.exe", script: "E:\\Agent Dock\\App\\resources\\engine\\src\\stop-all.mjs", configDir: "C:\\Users\\me\\AppData\\Roaming\\Agent Dock\\config" });
    expect(win.file).toMatch(/stop-all\.cmd$/);
    expect(win.content).toContain("set ELECTRON_RUN_AS_NODE=1\r\n");
    expect(win.content).toContain('"E:\\Agent Dock\\App\\Agent Dock.exe" "E:\\Agent Dock\\App\\resources\\engine\\src\\stop-all.mjs" --config "C:\\Users\\me\\AppData\\Roaming\\Agent Dock\\config" %*');
    const sh = stopLauncher({ platform: "linux", execPath: "/opt/Agent Dock/agent-dock", script: "/opt/it's/stop-all.mjs", configDir: "/home/me/.config/Agent Dock/config" });
    expect(sh.file).toMatch(/stop-all\.sh$/);
    expect(sh.content.startsWith("#!/bin/sh\n")).toBe(true);
    expect(sh.content).toContain(`ELECTRON_RUN_AS_NODE=1 exec '/opt/Agent Dock/agent-dock' '/opt/it'\\''s/stop-all.mjs' --config '/home/me/.config/Agent Dock/config' "$@"`);
  });
});
