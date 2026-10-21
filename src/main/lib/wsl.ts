// Opt-in WSL isolation (per project): the engine, and so every agent CLI and command it starts, runs
// inside a WSL distro instead of on Windows. The app still reads the state folder from Windows; paths
// are translated to /mnt/<drive>/… (or the distro's own path for \\wsl$ folders). Node.js, git and
// the agent CLIs must be installed and signed in inside the distro.

const WINDOWS_DRIVE = /^([A-Za-z]):[\\/]/;
const WSL_SHARE = /^\\\\wsl(?:\$|\.localhost)\\([^\\]+)(\\.*)?$/i;

export const isWindowsPath = (value: string) => WINDOWS_DRIVE.test(value) || WSL_SHARE.test(value);

/** A Windows path as the distro sees it; a \\wsl$ path must belong to the same distro. */
export function toWslPath(value: string, distro: string): string {
  const drive = WINDOWS_DRIVE.exec(value);
  if (drive) return `/mnt/${drive[1].toLowerCase()}/${value.slice(3).replace(/\\/g, "/")}`.replace(/\/+$/, "") || "/";
  const share = WSL_SHARE.exec(value);
  if (share) {
    if (share[1].toLowerCase() !== distro.toLowerCase()) throw new Error(`${value} belongs to the WSL distro ${share[1]}, not ${distro}.`);
    return (share[2] ?? "\\").replace(/\\/g, "/");
  }
  return value;
}

/** CLI locations found on Windows (codex.cmd, claude.exe …) cannot run in Linux; the distro's PATH is used instead. */
const COMMAND_FLAG = /^--[\w-]*(command|exe)$/;

/** Engine arguments for WSL: Windows paths translated, Windows CLI locations dropped. */
export function wslEngineArgs(args: string[], distro: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (COMMAND_FLAG.test(args[i]) && isWindowsPath(args[i + 1] ?? "")) { i++; continue; }
    out.push(isWindowsPath(args[i]) ? toWslPath(args[i], distro) : args[i]);
  }
  return out;
}

/** wsl.exe command line that runs the engine script inside the distro, from the state folder. */
export function wslLaunch(distro: string, script: string, stateDir: string, args: string[]): { command: string; args: string[] } {
  if (!/^[\w.-]{1,64}$/.test(distro)) throw new Error("Enter the WSL distro's name (wsl -l shows them).");
  return { command: "wsl.exe", args: ["-d", distro, "--cd", toWslPath(stateDir, distro), "--exec", "node", toWslPath(script, distro), ...wslEngineArgs(args, distro)] };
}

/** WSLENV entries so the given variables (provider keys, notification settings) reach the distro. */
export function wslEnv(base: string | undefined, keys: string[]): string {
  const entries = new Set((base ?? "").split(":").filter(Boolean));
  for (const key of keys) if (/^[A-Za-z_]\w*$/.test(key)) entries.add(`${key}/u`);
  return [...entries].join(":");
}

/**
 * Stop now under WSL isolation: ends the engine (engine-pid.json) and every process under it inside the
 * distro. Ending wsl.exe on Windows does not reach them. The pid must still be an Agent Dock engine
 * (its command line runs cli.mjs or elevate-cli.mjs), so a pid reused by another process is left alone.
 */
export function wslKillTree(distro: string, pid: number): { command: string; args: string[] } {
  if (!/^[\w.-]{1,64}$/.test(distro)) throw new Error("Enter the WSL distro's name (wsl -l shows them).");
  if (!Number.isInteger(pid) || pid <= 1) throw new Error("Not an engine process id.");
  // One line without double quotes or backslashes: it passes through the Windows command line and
  // wsl.exe unchanged ($1 is the pid, a number). xargs -0 turns the NUL-separated cmdline into words.
  const script = [
    "xargs -0 < /proc/$1/cmdline 2>/dev/null | grep -qE '(^|/)(elevate-)?cli[.]mjs( |$)' || exit 3",
    "kids() { pgrep -P $1 2>/dev/null || ps -o pid= --ppid $1 2>/dev/null; }",
    "k() { kill -STOP $1 2>/dev/null; for c in $(kids $1); do k $c; done; kill -KILL $1 2>/dev/null; }",
    "k $1",
  ].join("; ");
  return { command: "wsl.exe", args: ["-d", distro, "--exec", "sh", "-c", script, "agent-dock-stop", String(pid)] };
}
