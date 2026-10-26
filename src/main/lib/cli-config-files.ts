// Where Codex's config.toml and Claude Code's user settings.json are, for CLIs › Settings › Show config
// file. Agent Dock does not edit them (from 0.39): they change the CLI everywhere, also outside Agent Dock.
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ConfigFile, ConfigFileKind } from "@shared/cli-settings";

export type { ConfigFile, ConfigFileKind };

/** CODEX_HOME / CLAUDE_CONFIG_DIR when set, as the CLIs themselves read them. */
export function configFilePath(kind: ConfigFileKind, env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  if (kind === "codex") return path.join(env.CODEX_HOME?.trim() || path.join(home, ".codex"), "config.toml");
  return path.join(env.CLAUDE_CONFIG_DIR?.trim() || path.join(home, ".claude"), "settings.json");
}

export function configFile(kind: ConfigFileKind, file = configFilePath(kind)): ConfigFile {
  return { kind, path: file, exists: existsSync(file), folderExists: existsSync(path.dirname(file)) };
}
