import { spawn } from "node:child_process";

export function openDashboard(url, {
  platform = process.platform,
  spawnProcess = spawn,
  onError = (error) => console.error(`Could not open dashboard browser: ${error.message}`),
} = {}) {
  const [command, args] = platform === "win32"
    ? ["explorer.exe", [url]]
    : platform === "darwin"
      ? ["open", [url]]
      : ["xdg-open", [url]];
  const child = spawnProcess(command, args, { detached: true, windowsHide: true, stdio: "ignore" });
  child.on("error", onError);
  child.unref();
}
