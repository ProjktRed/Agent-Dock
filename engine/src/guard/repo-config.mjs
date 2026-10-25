import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// Configuration a repository can bring that makes a CLI run code. Codex loads a trusted project's
// .codex/ hooks, and Agent Dock starts Codex with --dangerously-bypass-hook-trust for its own guard
// hook, which also skips Codex's review of the repository's (confirmed on Codex 0.160). Cline runs the
// hooks in .clinerules/hooks/ with no review at all. Agents cannot write these folders (protected
// paths), but a cloned repository or a project check can, so every start looks for them first.
// Claude Code needs no check: it starts with --setting-sources user and --strict-mcp-config.
// OpenCode needs none: its guard sets OPENCODE_DISABLE_PROJECT_CONFIG and its own config folders.

const isFile = (file) => { try { return statSync(file).isFile(); } catch { return false; } };
const hasEntries = (dir) => { try { return statSync(dir).isDirectory() && readdirSync(dir).length > 0; } catch { return false; } };

/** A config.toml that mentions hooks anywhere outside a comment line counts (fail closed: no TOML parser here). */
function definesHooks(file) {
  if (!isFile(file)) return false;
  let text;
  try { text = readFileSync(file, "utf8"); } catch { return true; }
  return text.split(/\r?\n/).some((line) => !/^\s*#/.test(line) && /(^|[^\w])hooks([^\w]|$)/.test(line));
}

const CHECKS = {
  codex: (dir) => [
    ...(isFile(path.join(dir, ".codex", "hooks.json")) ? [".codex/hooks.json"] : []),
    ...(definesHooks(path.join(dir, ".codex", "config.toml")) ? [".codex/config.toml"] : []),
  ],
  cline: (dir) => (hasEntries(path.join(dir, ".clinerules", "hooks")) ? [".clinerules/hooks"] : []),
};

/** The folders a CLI reads project configuration from: the workspace and each parent up to its git root. */
function projectFolders(workspace) {
  const folders = [];
  for (let dir = path.resolve(workspace); ; ) {
    folders.push(dir);
    if (existsSync(path.join(dir, ".git"))) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return folders;
}

/** Repository files that would make this CLI run code, relative to the workspace ([] when none). */
export function repoCliConfigProblems(cli, workspace) {
  const check = CHECKS[cli];
  if (!check || !workspace) return [];
  const root = path.resolve(workspace);
  return projectFolders(root).flatMap((dir) => check(dir).map((file) => path.relative(root, path.join(dir, file)).replaceAll("\\", "/") || file));
}

const NAMES = { codex: "Codex", cline: "Cline" };
const WHY = {
  codex: "Agent Dock starts Codex with its hook review turned off (for Agent Dock's own guard hook), so Codex would run them unreviewed",
  cline: "Cline runs a repository's hooks without review",
};

/** Throws before the CLI starts when the repository brings hooks it would run. */
export function assertNoRepoCliConfig(cli, workspace) {
  const found = repoCliConfigProblems(cli, workspace);
  if (!found.length) return;
  throw new Error(`This repository has its own ${NAMES[cli]} hooks (${found.join(", ")}). ${WHY[cli]}, so ${NAMES[cli]} was not started. Remove or move them (agents cannot edit these files), then retry.`);
}
