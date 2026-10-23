// Imported first by the engine entry points, before anything starts a program.
// redact.mjs reads the secret values it hides from the environment, and action-log.mjs its signing key,
// so they load before those are removed here.
import "./redact.mjs";
import "./action-log.mjs";

// Windows: a bare program name (git, codex, claude, powershell) is resolved from PATH only, never from
// the current folder (cmd.exe and other launchers otherwise look there first). Child processes inherit it.
if (process.platform === "win32") process.env.NoDefaultCurrentDirectoryInExePath = "1";

// Settings only the engine itself uses (notification channels carry webhook URLs, bot tokens and API
// keys; the action log key signs its entries): read once into memory and removed from the environment,
// so no check command, model CLI or worker process the engine starts inherits them.
export const ENGINE_ONLY_ENV = ["AGENT_DOCK_NOTIFY", "AGENT_DOCK_LOG_KEY"];
const held = {};
for (const name of ENGINE_ONLY_ENV) {
  if (process.env[name] === undefined) continue;
  held[name] = process.env[name];
  delete process.env[name];
}

/** The engine-only settings this process started with. Never passed to any child process: only this engine notifies. */
export function engineOnlyEnv() {
  return { ...held };
}
