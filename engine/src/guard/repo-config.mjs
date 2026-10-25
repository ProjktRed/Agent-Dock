import { existsSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Configuration a repository can bring that makes a CLI run code. Codex applies a project's .codex/
// configuration (hooks, notify programs, MCP servers, model providers, sandbox settings) to Agent Dock's
// runs: for a project trusted in Codex, and also for an untrusted one once approval_policy is set, as
// Agent Dock does. Agent Dock also starts Codex with --dangerously-bypass-hook-trust for its own guard
// hook, which skips Codex's review of the repository's hooks (confirmed on Codex 0.160). Cline runs the
// hooks in .clinerules/hooks/ with no review at all. Agents cannot write these folders (protected
// paths), but a cloned repository or a project check can, so every start looks for them first.
// Claude Code needs no check: it starts with --setting-sources user and --strict-mcp-config.
// OpenCode needs none: its guard sets OPENCODE_DISABLE_PROJECT_CONFIG and its own config folders.

const isFile = (file) => { try { return statSync(file).isFile(); } catch { return false; } };
const hasEntries = (dir) => { try { return statSync(dir).isDirectory() && readdirSync(dir).length > 0; } catch { return false; } };

const CHECKS = {
  codex: (dir) => [".codex/config.toml", ".codex/hooks.json"].filter((file) => isFile(path.join(dir, file))),
  cline: (dir) => (hasEntries(path.join(dir, ".clinerules", "hooks")) ? [".clinerules/hooks"] : []),
};

/**
 * The folders a CLI reads project configuration from: the workspace and each parent up to its git root,
 * or only the workspace when it is not in a git repository (as Codex finds the project root). The user's
 * own ~/.codex is never a project folder.
 */
function projectFolders(workspace) {
  const start = path.resolve(workspace), home = path.resolve(os.homedir()), folders = [];
  for (let dir = start; ; ) {
    folders.push(dir);
    if (existsSync(path.join(dir, ".git"))) break;
    const parent = path.dirname(dir);
    if (parent === dir) { folders.length = 0; folders.push(start); break; }
    dir = parent;
  }
  return folders.filter((dir) => dir !== home);
}

/** Repository files that would make this CLI run code, relative to the workspace ([] when none). */
export function repoCliConfigProblems(cli, workspace) {
  const check = CHECKS[cli];
  if (!check || !workspace) return [];
  const root = path.resolve(workspace);
  return projectFolders(root).flatMap((dir) => check(dir).map((file) => path.relative(root, path.join(dir, file)).replaceAll("\\", "/") || file));
}

const WHAT = {
  codex: ["Codex configuration", "Codex would apply it to Agent Dock's runs, and it can make Codex run programs (hooks, notify, MCP servers) unreviewed, so Codex was not started"],
  cline: ["Cline hooks", "Cline runs a repository's hooks without review, so Cline was not started"],
};

/** Throws before the CLI starts when the repository brings configuration that would make it run code. */
export function assertNoRepoCliConfig(cli, workspace) {
  const found = repoCliConfigProblems(cli, workspace);
  if (!found.length) return;
  const [what, why] = WHAT[cli];
  throw new Error(`This repository has its own ${what} (${found.join(", ")}). ${why}. Move it out of the repository (agents cannot edit these files), then retry.`);
}
