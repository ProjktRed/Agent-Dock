import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { launchSpec } from "./cmd-line.mjs";

const WINDOWS_BUNDLED_RELATIVE = path.join(
  "node_modules",
  "@openai",
  "codex",
  "node_modules",
  "@openai",
  "codex-win32-x64",
  "vendor",
  "x86_64-pc-windows-msvc",
  "bin",
  "codex.exe",
);

async function defaultFileExists(file) {
  try {
    await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function unique(values) {
  return [...new Set(values.filter(Boolean).map((value) => path.resolve(value)))];
}

function windowsPathEntries(env) {
  return String(env.PATH ?? env.Path ?? "").split(";").filter(Boolean);
}

function windowsNpmBins(env) {
  return unique([
    env.APPDATA && path.join(env.APPDATA, "npm"),
    env.npm_config_prefix,
    ...windowsPathEntries(env),
  ]);
}

function directLauncher(command, source) {
  return { command, prefixArgs: [], displayCommand: command, source };
}

// The spawn sites pass command and arguments through launchSpec (cmd-line.mjs), which escapes them for cmd.exe.
function cmdLauncher(commandFile, env, source) {
  return {
    command: env.ComSpec ?? env.COMSPEC ?? "cmd.exe",
    prefixArgs: ["/d", "/s", "/c", commandFile],
    displayCommand: commandFile,
    source,
  };
}

async function resolveExplicit(command, { platform, env, fileExists, attempted }) {
  attempted.push(command);
  const hasPath = path.isAbsolute(command) || /[\\/]/.test(command);
  const candidates = hasPath
    ? [path.resolve(command)]
    : platform === "win32"
      ? windowsPathEntries(env).flatMap((directory) => [
          path.join(directory, command),
          path.join(directory, `${command}.exe`),
          path.join(directory, `${command}.cmd`),
        ])
      : [command];
  for (const candidate of candidates) {
    attempted.push(candidate);
    if (!hasPath && platform !== "win32") return directLauncher(command, "explicit");
    if (await fileExists(candidate)) {
      return candidate.toLowerCase().endsWith(".cmd")
        ? cmdLauncher(candidate, env, "explicit")
        : directLauncher(candidate, "explicit");
    }
  }
  return null;
}

function resolutionError({ attempted, platform, env, npmBins }) {
  return new Error([
    "Unable to resolve a runnable Codex command.",
    `Attempted Codex commands: ${[...new Set(attempted)].join(", ") || "none"}`,
    `OS: ${platform}`,
    `PATH: ${env.PATH ?? env.Path ?? "<unset>"}`,
    `npm bin candidates: ${npmBins.join(", ") || "none"}`,
    "Set CODEX_COMMAND or --codex-command to a working launcher.",
    "In PowerShell, run: Get-Command codex -All",
  ].join("\n"));
}

export async function resolveCodexCommand({
  explicitCommand,
  platform = process.platform,
  env = process.env,
  fileExists = defaultFileExists,
} = {}) {
  const attempted = [];
  const npmBins = platform === "win32" ? windowsNpmBins(env) : [];
  const configured = explicitCommand ?? env.CODEX_COMMAND;
  if (configured) {
    const resolved = await resolveExplicit(configured, { platform, env, fileExists, attempted });
    if (resolved) return resolved;
    throw resolutionError({ attempted, platform, env, npmBins });
  }

  if (platform !== "win32") return directLauncher("codex", "path-fallback");

  const executableCandidates = unique([
    ...npmBins.map((directory) => path.join(directory, WINDOWS_BUNDLED_RELATIVE)),
    ...windowsPathEntries(env).map((directory) => path.join(directory, "codex.exe")),
  ]);
  for (const candidate of executableCandidates) {
    attempted.push(candidate);
    if (await fileExists(candidate)) return directLauncher(candidate, "bundled-executable");
  }

  for (const directory of npmBins) {
    const candidate = path.join(directory, "codex.cmd");
    attempted.push(candidate);
    if (await fileExists(candidate)) return cmdLauncher(candidate, env, "path-cmd");
  }
  throw resolutionError({ attempted, platform, env, npmBins });
}

export function preflightCodex(launcher) {
  return new Promise((resolve, reject) => {
    const launch = launchSpec(launcher.command, [...launcher.prefixArgs, "--version"]);
    const child = spawn(launch.command, launch.args, {
      ...launch.options,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", (error) =>
      reject(new Error(`Codex preflight could not execute ${launcher.displayCommand}: ${error.message}`)),
    );
    child.on("close", (code) => {
      const version = output.trim();
      if (code === 0 && version) resolve({ command: launcher.displayCommand, version });
      else reject(new Error(`Codex preflight failed for ${launcher.displayCommand} (exit ${code ?? "unknown"}): ${version || "no output"}`));
    });
  });
}
