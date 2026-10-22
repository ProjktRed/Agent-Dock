// The CLIs' own config files, edited from CLIs › Settings (0.38): Codex's config.toml and Claude Code's
// user settings.json, the only two this reads or writes. These change the CLI everywhere, also outside
// Agent Dock. A save is checked first (TOML or a JSON object), refused if the file changed since it was
// read, keeps the previous version next to it (.agent-dock.bak) and replaces the file in one step.
import { copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import type { ConfigFile, RunSettingKind } from "@shared/cli-settings";

export type { ConfigFile };

export type ConfigFileKind = RunSettingKind;

const MAX_BYTES = 1_000_000;

/** CODEX_HOME / CLAUDE_CONFIG_DIR when set, as the CLIs themselves read them. */
export function configFilePath(kind: ConfigFileKind, env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  if (kind === "codex") return path.join(env.CODEX_HOME?.trim() || path.join(home, ".codex"), "config.toml");
  return path.join(env.CLAUDE_CONFIG_DIR?.trim() || path.join(home, ".claude"), "settings.json");
}

export async function readConfigFile(kind: ConfigFileKind, file = configFilePath(kind)): Promise<ConfigFile> {
  try {
    const info = await stat(file);
    if (info.size > MAX_BYTES) throw new Error(`${file} is larger than 1 MB; edit it in a text editor.`);
    return { kind, path: file, exists: true, text: await readFile(file, "utf8"), mtimeMs: info.mtimeMs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind, path: file, exists: false, text: "", mtimeMs: null };
    throw error;
  }
}

/** Why the text is not a valid config for that CLI, or null when it is. */
export function configProblem(kind: ConfigFileKind, text: string): string | null {
  if (Buffer.byteLength(text, "utf8") > MAX_BYTES) return "The file would be larger than 1 MB.";
  // A byte order mark (Notepad's "UTF-8 with BOM") is not part of the content.
  text = text.replace(/^﻿/, "");
  if (kind === "codex") {
    try { parseToml(text); return null; } catch (error) { return `Not valid TOML: ${(error as Error).message.split("\n")[0]}`; }
  }
  if (!text.trim()) return "Claude Code's settings.json must hold a JSON object, at least {}.";
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? null : "Claude Code's settings.json must hold a JSON object.";
  } catch (error) {
    return `Not valid JSON: ${(error as Error).message}`;
  }
}

export async function writeConfigFile(kind: ConfigFileKind, text: string, expectedMtimeMs: number | null, file = configFilePath(kind)): Promise<ConfigFile> {
  const problem = configProblem(kind, text);
  if (problem) throw new Error(problem);
  const current = await readConfigFile(kind, file);
  if (current.mtimeMs !== expectedMtimeMs) throw new Error(`${path.basename(file)} changed since it was opened. Reload it and make your change again.`);
  await mkdir(path.dirname(file), { recursive: true });
  if (current.exists) await copyFile(file, `${file}.agent-dock.bak`);
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, text, "utf8");
  await rename(temporary, file);
  return readConfigFile(kind, file);
}
