// Ollama's own server settings from CLIs › Ollama › Settings (0.38). On Windows Ollama reads them from your
// user environment when it starts, so a change applies after you quit and reopen Ollama. What the running
// Ollama actually uses comes from its server.log ("server config" line): Ollama's own settings window can
// override the environment (its models folder and context length, for example).
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { OLLAMA_SETTINGS, ollamaValue, type OllamaSettingsState } from "@shared/cli-settings";

const POWERSHELL = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
const KEYS = OLLAMA_SETTINGS.map((s) => s.key);

// Fixed scripts: names and values arrive in environment variables, never in the command text.
const READ_SCRIPT = "$o=@{}; foreach($n in ($env:AD_KEYS -split ',')){ $o[$n]=[Environment]::GetEnvironmentVariable($n,'User') }; $o | ConvertTo-Json -Compress";
const WRITE_SCRIPT = "$s=$env:AD_SET | ConvertFrom-Json; foreach($p in $s.PSObject.Properties){ [Environment]::SetEnvironmentVariable($p.Name, $p.Value, 'User') }";

function powershell(script: string, env: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(POWERSHELL, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { windowsHide: true, timeout: 30_000, encoding: "utf8", env: { ...process.env, ...env } },
      (error, stdout, stderr) => (error ? reject(new Error(String(stderr || error.message).trim())) : resolve(stdout)));
  });
}

/** An Ollama on this computer (its settings here are the ones it uses). */
export const isLocalUrl = (url: string) => /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/i.test(url.trim());

export function ollamaLogPath(platform = process.platform, env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string | null {
  if (platform === "win32") return path.join(env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "Ollama", "server.log");
  if (platform === "darwin") return path.join(home, ".ollama", "logs", "server.log");
  return null;
}

/** Our settings as the newest "server config" line of server.log reports them (flash attention as 1/0). */
export function parseServerConfig(log: string): { values: Record<string, string>; at: string | null } | null {
  const line = log.split(/\r?\n/).reverse().find((l) => l.includes('msg="server config"'));
  if (!line) return null;
  const values: Record<string, string> = {};
  for (const key of KEYS) {
    const m = line.match(new RegExp(`[\\[ ]${key}:(.*?)(?= [A-Z][A-Z0-9_]*:|\\]"?\\s*$)`));
    if (!m) continue;
    let value = m[1].replaceAll("\\\\", "\\");
    if (key === "OLLAMA_FLASH_ATTENTION") value = value === "true" ? "1" : value === "false" ? "0" : value;
    values[key] = value;
  }
  return { values, at: line.match(/time=(\S+)/)?.[1] ?? null };
}

export async function readOllamaSettings(): Promise<OllamaSettingsState> {
  const editable = process.platform === "win32";
  let saved: Record<string, string | null> = Object.fromEntries(KEYS.map((k) => [k, null]));
  if (editable) {
    const out = JSON.parse((await powershell(READ_SCRIPT, { AD_KEYS: KEYS.join(",") })).trim() || "{}") as Record<string, string | null>;
    saved = Object.fromEntries(KEYS.map((k) => [k, typeof out[k] === "string" && out[k] ? out[k] : null]));
  }
  const log = ollamaLogPath();
  const running = log ? parseServerConfig(await readFile(log, "utf8").catch(() => "")) : null;
  return { editable, saved, running };
}

/** Sets (a value) or clears (null) each listed setting in your user environment; anything not valid is refused. */
export async function writeOllamaSettings(changes: Record<string, string | null>): Promise<OllamaSettingsState> {
  if (process.platform !== "win32") throw new Error("Ollama's settings are changed from the app on Windows only. On Linux and macOS, set them on Ollama's service.");
  const set: Record<string, string | null> = {};
  for (const [key, raw] of Object.entries(changes)) {
    const def = OLLAMA_SETTINGS.find((s) => s.key === key);
    if (!def) throw new Error(`${key} is not an Ollama setting Agent Dock changes.`);
    if (raw === null || raw.trim() === "") { set[key] = null; continue; }
    const value = ollamaValue(def, raw);
    if (value === null) throw new Error(`${def.label}: “${raw}” is not a valid value.`);
    set[key] = value;
  }
  if (Object.keys(set).length) await powershell(WRITE_SCRIPT, { AD_SET: JSON.stringify(set) });
  return readOllamaSettings();
}
