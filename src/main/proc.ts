import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { rm } from "node:fs/promises";
import { cmdLine, resolveProgram } from "./lib/cmd-line";

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
 * Starts a CLI. Windows: through cmd.exe (`shell: true`) so npm's .cmd launchers run, with the program
 * resolved through PATH and PATHEXT and every argument escaped for cmd (lib/cmd-line); elsewhere
 * directly. Arguments are passed as they are, never pre-quoted. Throws when one cannot be passed safely.
 */
export function spawnCli(command: string, args: string[], options: SpawnOptionsWithoutStdio = {}): ChildProcessWithoutNullStreams {
  const program = command.replace(/^"(.*)"$/, "$1");
  return process.platform === "win32"
    ? spawn(cmdLine(resolveProgram(program, options.env ?? process.env), args), { ...options, shell: true, windowsHide: true })
    : spawn(program, args, { ...options, windowsHide: true });
}
