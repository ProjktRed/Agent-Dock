import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Opens the dashboard in the browser. A URL that carries the sign-in token is never put on a command line
 * (other local users can read process arguments): it goes into a private launch page in launchDir, which
 * the browser opens and which is removed after a minute.
 */
export function openDashboard(url, {
  platform = process.platform,
  spawnProcess = spawn,
  launchDir = null,
  removeAfterMs = 60_000,
  onError = (error) => console.error(`Could not open dashboard browser: ${error.message}`),
} = {}) {
  let target = url;
  if (launchDir && url.includes("#token=")) {
    target = path.join(launchDir, `dashboard-launch-${randomBytes(6).toString("hex")}.html`);
    const json = JSON.stringify(url).replace(/</g, "\\u003c");
    writeFileSync(target, `<!doctype html><meta charset="utf-8"><title>Agent Dock dashboard</title><script>location.replace(${json})</script>\n`, { mode: 0o600 });
    setTimeout(() => rmSync(target, { force: true }), removeAfterMs).unref();
  }
  const [command, args] = platform === "win32"
    ? ["explorer.exe", [target]]
    : platform === "darwin"
      ? ["open", [target]]
      : ["xdg-open", [target]];
  const child = spawnProcess(command, args, { detached: true, windowsHide: true, stdio: "ignore" });
  child.on("error", onError);
  child.unref();
  return target;
}
