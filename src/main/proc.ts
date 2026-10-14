import { spawn, type ChildProcess } from "node:child_process";
import { rm } from "node:fs/promises";

/**
 * Stops a CLI started with `shell: true` and removes its temporary working folder.
 * `child.kill()` only ends the cmd.exe wrapper, so the CLI itself is killed by process tree;
 * the folder is removed once nothing holds it, with retries, and a failure is ignored (it is
 * only a leftover empty folder in %TEMP%). Never throws.
 */
export function stopAndClean(child: ChildProcess, dir: string): void {
  try {
    child.stdin?.end();
  } catch {
    // stdin already closed
  }
  const clean = () => void rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => undefined);
  if (process.platform !== "win32" || !child.pid || child.exitCode !== null) {
    child.kill();
    setTimeout(clean, 1000);
    return;
  }
  const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  killer.on("error", () => {
    child.kill();
    setTimeout(clean, 1000);
  });
  killer.on("exit", () => setTimeout(clean, 500));
}

/**
 * The command line for a `shell: true` spawn, joined the way Node joins command and arguments.
 * Passing it whole (no argument array) keeps the same behaviour without Node's DEP0190 warning.
 */
export const shellLine = (command: string, args: string[]) => [command, ...args].join(" ");
