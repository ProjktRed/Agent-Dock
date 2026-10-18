import path from "node:path";
import { fileURLToPath } from "node:url";
import { decide } from "../decide.mjs";
import { parsePatchPaths } from "../action.mjs";
import {stripCheckOutputFilter} from '../check-output-filter.mjs';
import {
  CODEX_EDIT_MUST_BE_PATCH,
  codexHookError,
  CODEX_MCP_DENIED,
  CODEX_PATCH_NO_FILES,
  codexOutsidePaths,
  codexShellDenied,
} from "../reasons.mjs";

const SHELLS = new Set(["bash", "sh", "zsh", "powershell", "powershell.exe", "pwsh", "pwsh.exe", "cmd", "cmd.exe"]);
const SHELL_FLAGS = new Set(["-c", "-lc", "-command", "/c", "-noprofile", "-nologo", "-noninteractive", "-executionpolicy", "bypass", "-l"]);
const READ_ONLY = [
  "git status", "git diff", "git log", "git show", "git rev-parse", "git ls-files", "git branch --show-current",
  "cat", "type", "ls", "dir", "rg", "grep", "findstr", "head", "tail", "wc", "pwd", "echo",
  "sed -n", "get-content", "get-childitem", "select-string", "test-path", "resolve-path", "get-location",
];
const CHECKS = ["npm test", "npm run test", "npm run typecheck", "npm run lint", "npx tsc", "npx eslint", "npx prettier --check", "npx vitest run"];

const norm = (p) => path.resolve(p).replaceAll("\\", "/").toLowerCase();
const HOOK_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "codex-scope-hook.mjs");

/** Files a Codex patch adds, updates, deletes or moves to. Null means no patch input. */
export function patchPaths(toolInput) {
  return parsePatchPaths(toolInput, { requireBegin: true, trimPaths: true });
}

/** Unwraps `powershell -Command "<script>"`, `bash -lc "<script>"` and similar. */
export function shellScript(toolInput) {
  const raw = toolInput?.command ?? toolInput?.cmd ?? toolInput?.script ?? null;
  if (typeof raw === "string") return raw;
  if (!Array.isArray(raw) || !raw.length) return null;
  const parts = raw.map(String);
  if (SHELLS.has(path.basename(parts[0]).toLowerCase())) {
    const rest = parts.slice(1).filter((p) => !SHELL_FLAGS.has(p.toLowerCase()));
    return rest.join(" ");
  }
  return parts.join(" ");
}

/** Every shell segment must be an allowed check or read-only command, with no redirection. */
export function shellAllowed(script, qaCommand) {
  const base = stripCheckOutputFilter(script);
  if(base===null)return false;
  const text = base.trim().replace(/^(npm|npx)\.cmd\b/i,'$1');
  if (!text || /[<>]/.test(text)) return false;
  if (/[`]|\$\(|<\(|>(?!&1)/.test(text.replace(/2>&1/g, ""))) return false;
  const allowed = [...READ_ONLY, ...CHECKS, ...(qaCommand?.trim() ? [qaCommand.trim().toLowerCase()] : [])];
  return text.split(/&&|\|\||;|\|/).every((segment) => {
    const s = segment.trim().toLowerCase().replace(/\s+/g, " ");
    if (!s) return true;
    if (/^find\b/.test(s)) return !/-(delete|exec|execdir|ok|fprint)/.test(s);
    return allowed.some((prefix) => s === prefix || s.startsWith(prefix + " "));
  });
}

export function toAction(event) {
  const tool = String(event?.tool_name ?? "");
  const input = event?.tool_input;
  // Classify by the native tool, never by patch-looking text inside a shell script.
  const touched = /(?:^|[._])(?:apply_patch|patch)$/i.test(tool) ? patchPaths(input) : null;
  if (touched !== null) return { kind: "edit", tool, input, paths: touched, patch: true, cwd: event?.cwd };
  if (/patch|edit|write/i.test(tool)) return { kind: "edit", tool, input, paths: [], patch: false, cwd: event?.cwd };
  const script = shellScript(input);
  if (script !== null) return { kind: "command", tool, input, commands: [script], cwd: input?.workdir ?? input?.cwd ?? event?.cwd };
  if (tool.startsWith("mcp__")) return { kind: "unknown", tool, input };
  const native=tool.split('.').at(-1).toLowerCase();
  const kind=['read','read_file','read_files','view_image'].includes(native)?'read'
    : ['grep','glob','grep_files','list_dir','list_directory','search_codebase','update_plan','request_user_input'].includes(native)?'inspect':'unknown';
  return { kind, tool, input, cwd: event?.cwd };
}

export function checkToolUse(policy, event) {
  const result = decide(policy, toAction(event), { adapter, mode: "hook" });
  return result.effect === "allow" ? null : result.reason;
}

export function codexScopeHookArgs({ nodePath = process.execPath, hookScript = HOOK_SCRIPT, policyFile, logFile }) {
  const command = [nodePath, hookScript, policyFile, logFile].map((p) => `"${p}"`).join(" ");
  return ["--dangerously-bypass-hook-trust", "-c", `hooks.PreToolUse=[{matcher=".*",hooks=[{type="command",command=${JSON.stringify(command)},timeout=30}]}]`];
}

export const adapter = {
  id: "codex",
  label: "Codex",
  stateSubdir: "codex",
  capabilities: {
    narrowsToolSchema: false, enumeratesCommands: false, postToolEvents: false,
    outOfProcessHooks: true, counters: false, editDiscipline: false,
  },
  toAction,
  toControl(decision) {
    return decision.effect === "allow"
      ? { exitCode: 0 }
      : { exitCode: 2, stderr: decision.reason };
  },
  patchPaths: (input) => parsePatchPaths(input, { requireBegin: true, trimPaths: true }),
  shellScript,
  approvedPath(policy, file, cwd = policy.workspace) {
    const allowed = new Set(policy.allowedPaths.map((p) => norm(path.resolve(policy.workspace, p))));
    return allowed.has(norm(path.resolve(cwd || policy.workspace, file)));
  },
  validatePolicy(policy) {
    return new Set(policy.allowedPaths.map((p) => norm(path.resolve(policy.workspace, p))));
  },
  approvedCommand(policy, script) {
    return !policy.toolGuard || shellAllowed(script, policy.qaCommand);
  },
  reasons: {
    patchNoFiles: CODEX_PATCH_NO_FILES,
    patchOutside: codexOutsidePaths,
    editMustBePatch: CODEX_EDIT_MUST_BE_PATCH,
    commandNotApproved: codexShellDenied,
    unknownTool: CODEX_MCP_DENIED,
    hookError: codexHookError,
  },
  install({ nodePath = process.execPath, hookScript = HOOK_SCRIPT, policyFile, logFile }) {
    return { launchArgs: codexScopeHookArgs({ nodePath, hookScript, policyFile, logFile }) };
  },
};

export default adapter;
