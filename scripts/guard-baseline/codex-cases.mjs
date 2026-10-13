// The Codex scope rail, frozen before Part 2 folds it into the shared layer.
//
// Each case is one `node engine/src/codex-scope-hook.mjs <policy.json> <log.ndjson>` subprocess
// with a PreToolUse event on stdin — exactly how cloud-impl-worker.mjs:145 wires it. What is
// recorded is the pair the rail actually contracts on: the process exit code (0 allow, 2 deny) and
// the exact stderr reason, plus the decision line the hook appends to its log, which
// cloud-impl-worker.mjs:163-167 reads to refuse an attempt that ran tools with no hook decisions.
//
// Every case runs twice, once with `toolGuard: true` and once with `false`, because the flag
// changes the decision for shell and MCP calls but not for patches.

export const CODEX_POLICY = {
  // `workspace` is filled in with the throwaway workspace path at capture time.
  allowedPaths: ["src/alpha.ts", "src/inscope/"],
  qaCommand: "npm run check",
};

const patch = (body) => `*** Begin Patch\n${body}\n*** End Patch`;

export const CODEX_CASES = [
  {
    name: "patch-in-scope",
    event: { tool_name: "apply_patch", tool_input: { input: patch("*** Update File: src/alpha.ts\n@@\n-export const ALPHA_VERSION = 1;\n+export const ALPHA_VERSION = 2;") } },
  },
  {
    name: "patch-out-of-scope",
    event: { tool_name: "apply_patch", tool_input: { input: patch("*** Update File: src/beta.ts\n@@\n-export const BETA_VERSION = 1;\n+export const BETA_VERSION = 2;") } },
  },
  {
    name: "patch-multiple-one-outside",
    event: { tool_name: "apply_patch", tool_input: { input: patch("*** Update File: src/alpha.ts\n@@\n-a\n+b\n*** Add File: src/gamma.ts\n+export const GAMMA = 1;") } },
  },
  {
    name: "patch-names-no-files",
    event: { tool_name: "apply_patch", tool_input: { input: patch("@@\n-export const ALPHA_VERSION = 1;\n+export const ALPHA_VERSION = 2;") } },
  },
  {
    name: "patch-add-file-in-scope-directory",
    event: { tool_name: "apply_patch", tool_input: { input: patch("*** Add File: src/inscope/new.ts\n+export const NEW = 1;") } },
    note: "codex-scope-guard.mjs:69 compares against the exact resolved allowedPaths set, so a new file inside an allowed directory is denied. Recorded, not corrected.",
  },
  {
    name: "tool-named-edit",
    event: { tool_name: "edit", tool_input: { path: "src/alpha.ts", content: "export const ALPHA_VERSION = 2;\n" } },
  },
  {
    name: "tool-named-write",
    event: { tool_name: "write", tool_input: { file_path: "src/alpha.ts", contents: "export const ALPHA_VERSION = 2;\n" } },
  },
  {
    name: "tool-named-patch-without-patch-body",
    event: { tool_name: "apply_patch", tool_input: { input: "no envelope here" } },
  },
  {
    name: "shell-qa-command",
    event: { tool_name: "shell", tool_input: { command: ["npm", "run", "check"] } },
  },
  {
    name: "shell-read-only",
    event: { tool_name: "shell", tool_input: { command: "git status --short" } },
  },
  {
    name: "shell-denied-segment",
    event: { tool_name: "shell", tool_input: { command: "npm run check && rm -rf src" } },
  },
  {
    name: "shell-bash-lc-wrapper-allowed",
    event: { tool_name: "shell", tool_input: { command: ["bash", "-lc", "npm run check"] } },
  },
  {
    name: "shell-bash-lc-wrapper-denied",
    event: { tool_name: "shell", tool_input: { command: ["bash", "-lc", "git push origin main"] } },
  },
  {
    name: "shell-powershell-wrapper-denied",
    event: { tool_name: "shell", tool_input: { command: ["powershell.exe", "-NoProfile", "-Command", "Set-Content src/beta.ts 'x'"] } },
  },
  {
    name: "shell-redirection",
    event: { tool_name: "shell", tool_input: { command: "git status --short > out.txt" } },
  },
  {
    name: "shell-stderr-redirect-allowed",
    event: { tool_name: "shell", tool_input: { command: "npm run check 2>&1" } },
  },
  {
    name: "shell-find-with-delete",
    event: { tool_name: "shell", tool_input: { command: "find src -name '*.ts' -delete" } },
  },
  {
    name: "mcp-tool",
    event: { tool_name: "mcp__github__create_pull_request", tool_input: { title: "x" } },
  },
  {
    name: "unknown-non-shell-tool",
    event: { tool_name: "update_plan", tool_input: { plan: ["step one"] } },
  },
];

/** Cases that break the hook itself. `policy: "corrupt"` / `stdin: "<raw>"` instead of an event. */
export const CODEX_FAILURE_CASES = [
  { name: "corrupt-policy-file", policy: "corrupt", event: { tool_name: "shell", tool_input: { command: "git status" } } },
  { name: "missing-policy-file", policy: "missing", event: { tool_name: "shell", tool_input: { command: "git status" } } },
  { name: "malformed-stdin", stdin: "{not json" },
  { name: "empty-stdin", stdin: "" },
];
