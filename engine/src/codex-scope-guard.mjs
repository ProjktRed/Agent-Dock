import path from "node:path";

// Scope policy for Codex as the implementation worker, enforced by a Codex PreToolUse hook
// (codex-scope-hook.mjs) while Codex runs: patches may only touch the task's allowed paths, and
// with the tool guard on the shell is limited to the task's checks and read-only commands.
// Fails closed: anything it cannot read is denied.

const SHELLS = new Set(["bash", "sh", "zsh", "powershell", "powershell.exe", "pwsh", "pwsh.exe", "cmd", "cmd.exe"]);
const SHELL_FLAGS = new Set(["-c", "-lc", "-command", "/c", "-noprofile", "-nologo", "-noninteractive", "-executionpolicy", "bypass", "-l"]);
const READ_ONLY = [
  "git status", "git diff", "git log", "git show", "git rev-parse", "git ls-files", "git branch --show-current",
  "cat", "type", "ls", "dir", "rg", "grep", "findstr", "head", "tail", "wc", "pwd", "echo",
  "sed -n", "get-content", "get-childitem", "select-string", "test-path", "resolve-path", "get-location",
];
const CHECKS = ["npm test", "npm run test", "npm run typecheck", "npm run lint", "npx tsc", "npx eslint", "npx prettier --check", "npx vitest run"];

const norm = (p) => path.resolve(p).replaceAll("\\", "/").toLowerCase();

/** Every string inside a tool input (patch tools send the patch as a string, an array or an object field). */
function strings(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => strings(v, out));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => strings(v, out));
  return out;
}

/** Files a Codex patch adds, updates, deletes or moves to. Null when the input holds no patch. */
export function patchPaths(toolInput) {
  const text = strings(toolInput).join("\n");
  if (!/\*\*\* Begin Patch/.test(text)) return null;
  return [...text.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+?)\s*$/gm)].map((m) => m[1]);
}

/** The script a shell tool runs, unwrapping `powershell -Command "<script>"`, `bash -lc "<script>"` and similar. */
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

/** With the tool guard on: every segment of the command must be an allowed check or a read-only command, with no redirection. */
export function shellAllowed(script, qaCommand) {
  const text = script.trim();
  if (!text) return false;
  if (/[`]|\$\(|<\(|>(?!&1)/.test(text.replace(/2>&1/g, ""))) return false;
  const allowed = [...READ_ONLY, ...CHECKS, ...(qaCommand?.trim() ? [qaCommand.trim().toLowerCase()] : [])];
  return text.split(/&&|\|\||;|\|/).every((segment) => {
    const s = segment.trim().toLowerCase().replace(/\s+/g, " ");
    if (!s) return true;
    if (/^find\b/.test(s)) return !/-(delete|exec|execdir|ok|fprint)/.test(s);
    return allowed.some((prefix) => s === prefix || s.startsWith(prefix + " "));
  });
}

/**
 * Decide one Codex tool call. policy: { workspace, allowedPaths, qaCommand, toolGuard }.
 * event: the PreToolUse hook input ({ tool_name, tool_input, cwd }). Returns null to allow, or a reason.
 */
export function checkToolUse(policy, event) {
  const tool = String(event?.tool_name ?? "");
  const input = event?.tool_input;
  const base = event?.cwd || policy.workspace;
  const allowed = new Set(policy.allowedPaths.map((p) => norm(path.resolve(policy.workspace, p))));
  const touched = patchPaths(input);
  if (touched) {
    if (!touched.length) return "The patch names no files; only the task's approved paths may change.";
    const outside = touched.filter((p) => !allowed.has(norm(path.resolve(base, p))));
    return outside.length ? `Outside the task's approved paths: ${outside.join(", ")}. Change only: ${policy.allowedPaths.join(", ")}.` : null;
  }
  if (/patch|edit|write/i.test(tool)) return "File changes must be a patch on the task's approved paths.";
  const script = shellScript(input);
  if (script !== null) {
    if (!policy.toolGuard) return null;
    return shellAllowed(script, policy.qaCommand) ? null : `Tool guard: only the task's check (${policy.qaCommand}), lint/typecheck and read-only commands may run. Edit files with a patch on the approved paths.`;
  }
  if (policy.toolGuard && tool.startsWith("mcp__")) return "Tool guard: MCP tools are not available to the implementation worker.";
  return null;
}
