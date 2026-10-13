// Direct harness cases: the guard decisions no scripted model turn can express.
//
// A case is an ordered list of steps that lib/runner.mjs executes against one throwaway
// workspace + state dir. Step shapes are documented in lib/runner.mjs. `{{WS}}` is replaced with
// the throwaway workspace path, exactly as in scenarios.mjs.
//
// Several cases deliberately reset counters mid-case with an explicit `state.policy` step. Without
// it the second rejection of a group would trip the two-failed-edits / three-invalid-requests hard
// stop and every later step would only ever record the already-stopped branch. The reset is a
// recorded step like any other, so replay re-applies it and nothing is hidden.

const ALPHA = "{{WS}}/src/alpha.ts";
const BETA = "{{WS}}/src/beta.ts";
const KEEP = "{{WS}}/src/inscope/keep.ts";

/** The real read_files result shape, taken from a Cline 3.0.70 run against the stub. */
const readResult = (file, lines) => ({
  name: "read_files",
  input: { files: [{ path: file }] },
  output: JSON.stringify([{ query: file, result: lines.map(([n, text]) => `${n} | ${text}`).join("\n"), success: true }]),
  success: true,
});

const ALPHA_LINES = [
  [1, "export const ALPHA_VERSION = 1;"],
  [2, "export function alpha(): string {"],
  [3, '  return "alpha";'],
  [4, "}"],
];

const readAlphaFull = readResult(ALPHA, ALPHA_LINES);
const readAlphaTail = readResult(ALPHA, ALPHA_LINES.slice(2));

/** Counter reset. Keeps editFailures unless `clearFailures` is asked for. */
const reset = (extra = {}) => ({ at: "state.policy", patch: { stopped: false, reason: null, failedEdits: 0, invalidToolCalls: 0, ...extra } });

const editorCall = (input, id) => ({ at: "plugin.beforeTool", call: { name: "editor", input, ...(id ? { id } : {}) } });
const patchCall = (input, id) => ({ at: "plugin.beforeTool", call: { name: "apply_patch", input, ...(id ? { id } : {}) } });

const patch = (body) => `*** Begin Patch\n${body}\n*** End Patch`;
const alphaPatch = patch(`*** Update File: src/alpha.ts\n@@\n-export const ALPHA_VERSION = 1;\n+export const ALPHA_VERSION = 2;`);
const betaPatch = patch(`*** Update File: src/beta.ts\n@@\n-export const BETA_VERSION = 1;\n+export const BETA_VERSION = 2;`);
// 4000 is the cline-edit-boundary.mjs:38 ceiling; this clears it with explicit, readable filler.
const oversizePatch = patch(`*** Update File: src/alpha.ts\n@@\n${Array.from({ length: 120 }, (_, i) => `+// filler line ${String(i).padStart(4, "0")} ${"-".repeat(20)}`).join("\n")}`);
const bigNewText = `export const ALPHA_VERSION = 2;\n${"// ".repeat(1240)}\n`;

export const DIRECT_CASES = [
  {
    name: "plugin-narrowing-full-catalog",
    covers: ["beforeModel narrowing over the full Cline catalog plus the three tools Cline 3.0.70 does not register"],
    steps: [{ at: "plugin.beforeModel", catalog: "full" }],
  },
  {
    name: "plugin-narrowing-observed-catalog",
    covers: ["beforeModel narrowing over exactly the catalog a real Cline 3.0.70 sends"],
    steps: [{ at: "plugin.beforeModel", catalog: "observed" }],
  },
  {
    name: "plugin-handshake-missing",
    covers: ["beforeTool before any beforeModel (cline-tool-guard.mjs:75)"],
    steps: [editorCall({ path: ALPHA, old_text: "export const ALPHA_VERSION = 1;", new_text: "export const ALPHA_VERSION = 2;" })],
  },
  {
    name: "plugin-missing-command-choices",
    covers: ["beforeModel with an empty commandChoices list (cline-tool-guard.mjs:53)"],
    steps: [
      { at: "state.policy", patch: { commandChoices: [] } },
      { at: "plugin.beforeModel", catalog: "observed" },
    ],
  },
  {
    name: "plugin-command-safety-failed",
    covers: ["an in-enum command that no longer passes approvedCommand (cline-tool-guard.mjs:80)"],
    steps: [
      { at: "plugin.beforeModel", catalog: "observed" },
      { at: "fs.delete", file: "src/alpha.ts" },
      { at: "plugin.beforeTool", call: { name: "run_commands", input: { commands: ["npx prettier --write src/alpha.ts"] } } },
    ],
  },
  {
    name: "plugin-unsafe-command",
    covers: ["unsafe command reaching beforeTool (cline-tool-guard.mjs:82) — unreachable through real Cline, where the file hook cancels first"],
    steps: [
      { at: "plugin.beforeModel", catalog: "observed" },
      { at: "plugin.beforeTool", call: { name: "run_commands", input: { commands: ["git push origin main"] } } },
    ],
  },
  {
    name: "plugin-unapproved-tool-path",
    covers: ["an unregistered tool with an out-of-scope path reaching beforeTool (cline-tool-guard.mjs:86)"],
    steps: [
      { at: "plugin.beforeModel", catalog: "observed" },
      { at: "plugin.beforeTool", call: { name: "write_to_file", input: { path: BETA, content: "export const BETA_VERSION = 3;\n" } } },
    ],
  },
  {
    name: "plugin-already-stopped",
    covers: ["the three already-stopped branches (cline-tool-guard.mjs:52, :67, :74)"],
    steps: [
      { at: "state.policy", patch: { stopped: true, reason: "command safety validation failed" } },
      { at: "plugin.beforeModel", catalog: "observed" },
      { at: "plugin.afterModel", calls: [{ name: "web_search", input: { query: "typescript const" }, id: "tc-stopped-1" }] },
      editorCall({ path: ALPHA, new_text: "export const ALPHA_VERSION = 2;\n" }, "tc-stopped-2"),
    ],
  },
  {
    name: "plugin-edit-discipline",
    covers: [
      "whole-file rewrite of an existing file", "non-unique old_text", "replacement outside the read range",
      "insert_line outside the read range", "both edit modes at once", "oversized new_text",
      "replacement on a missing file", "no fresh read", "a repeated identical failed edit",
      "an edit source over 1 MB",
    ],
    steps: [
      { at: "plugin.beforeModel", catalog: "observed" },
      { at: "hook.PostToolUse", call: readAlphaFull },

      editorCall({ path: ALPHA, new_text: "export const ALPHA_VERSION = 2;\n" }, "tc-whole-file"),
      reset(),
      editorCall({ path: ALPHA, old_text: "export ", new_text: "exported " }, "tc-not-unique"),
      reset(),
      editorCall({ path: ALPHA, old_text: "export const ALPHA_VERSION = 1;", new_text: "export const ALPHA_VERSION = 2;", insert_line: 2 }, "tc-both-modes"),
      reset(),
      editorCall({ path: ALPHA, new_text: bigNewText, old_text: "export const ALPHA_VERSION = 1;" }, "tc-oversize-text"),
      reset(),
      editorCall({ path: "{{WS}}/src/inscope/missing.ts", old_text: "anything", new_text: "something" }, "tc-missing-file"),
      reset(),
      editorCall({ path: KEEP, old_text: "export const KEEP = true;", new_text: "export const KEEP = false;" }, "tc-unread-file"),
      reset(),

      // Narrow the recorded fresh-read range to lines 3-4, then edit line 1 and insert at line 1.
      { at: "hook.PostToolUse", call: readAlphaTail },
      editorCall({ path: ALPHA, old_text: "export const ALPHA_VERSION = 1;", new_text: "export const ALPHA_VERSION = 2;" }, "tc-outside-range"),
      reset(),
      editorCall({ path: ALPHA, insert_line: 1, new_text: "// header\n" }, "tc-insert-outside"),
      reset(),

      // A native failure recorded by PostToolUse, then the identical edit proposed again.
      { at: "hook.PostToolUse", call: { name: "editor", id: "tc-native-fail", input: { path: ALPHA, old_text: "nonexistent", new_text: "x" }, output: JSON.stringify({ query: `edit:${ALPHA}`, error: "Editor operation failed: text not found", success: false }), success: false } },
      reset(),
      editorCall({ path: ALPHA, old_text: "nonexistent", new_text: "x" }, "tc-identical-retry"),
      reset(),

      { at: "fs.fill", file: "src/inscope/big.ts", bytes: 1_100_000, unit: "x" },
      editorCall({ path: "{{WS}}/src/inscope/big.ts", old_text: "xxxx", new_text: "yyyy" }, "tc-big-source"),
    ],
  },
  {
    name: "plugin-patch-discipline",
    covers: [
      "apply_patch over 4000 characters", "apply_patch with no *** headers", "a non-string patch",
      "a patch outside scope", "a patch over a file changed since the read", "an approved patch",
    ],
    steps: [
      { at: "plugin.beforeModel", catalog: "full" },
      { at: "hook.PostToolUse", call: readAlphaFull },

      patchCall({ input: oversizePatch }, "tc-patch-oversize"),
      reset(),
      patchCall({ input: alphaPatch }, "tc-patch-approved"),
      reset(),
      patchCall({ input: "this is not a patch at all" }, "tc-patch-no-headers"),
      reset(),
      patchCall({ input: 123 }, "tc-patch-malformed"),
      reset(),
      patchCall({ input: betaPatch }, "tc-patch-out-of-scope"),
      reset(),
      { at: "fs.write", file: "src/alpha.ts", content: "export const ALPHA_VERSION = 1;\nexport function alpha(): string {\n  return \"alpha\";\n}\n// changed after the read\n" },
      patchCall({ input: alphaPatch }, "tc-patch-stale-read"),
    ],
  },
  {
    name: "hook-degenerate-inputs",
    covers: [
      "malformed JSON on stdin", "a missing hookName", "a missing tool identity", "a missing tool input",
      "stdin over 1 MB", "a corrupt policy.json", "a policy.json that fails validation", "a stale policy.json.lock",
    ],
    steps: [
      { at: "hook.PreToolUse", stdin: "{not json" },
      reset(),
      { at: "hook.PreToolUse", payload: {} },
      reset(),
      { at: "hook.PreToolUse", payload: { hookName: "tool_call" } },
      reset(),
      { at: "hook.PreToolUse", payload: { hookName: "tool_call", tool_call: { name: "editor" } } },
      reset(),
      { at: "hook.PreToolUse", stdinRepeat: { unit: "x", bytes: 1_100_000 } },

      { at: "state.policy", raw: '{"version":1,' },
      { at: "hook.PreToolUse", call: { name: "editor", input: { path: ALPHA, old_text: "a", new_text: "b" } } },
      { at: "state.policy", restore: "prepared", patch: { version: 2 } },
      { at: "hook.PreToolUse", call: { name: "editor", input: { path: ALPHA, old_text: "a", new_text: "b" } } },
      { at: "state.policy", restore: "prepared" },
      { at: "state.lock", create: true },
      { at: "hook.PreToolUse", call: { name: "editor", input: { path: ALPHA, old_text: "a", new_text: "b" } } },
      { at: "state.lock", create: false },
      { at: "hook.PreToolUse", call: { name: "editor", input: { path: ALPHA, old_text: "a", new_text: "b" } } },
    ],
  },
  {
    name: "hook-unknown-tool-and-command",
    covers: [
      "an unknown tool before the plugin handshake (cline-tool-guard.mjs:194)",
      "an unapproved command before the plugin handshake (:190)",
      "an unknown tool with an out-of-scope path after the handshake (:194)",
      "the post-handshake allow branches (:189, :192, :193)",
    ],
    steps: [
      { at: "hook.PreToolUse", call: { name: "web_search", input: { query: "typescript const" } } },
      reset(),
      { at: "hook.PreToolUse", call: { name: "run_commands", input: { commands: ["npm run deploy"] } } },
      reset(),
      { at: "hook.PreToolUse", call: { name: "editor", input: { path: BETA, old_text: "a", new_text: "b" } } },
      reset(),

      { at: "state.policy", patch: { runtimeReady: true } },
      { at: "hook.PreToolUse", call: { name: "write_to_file", input: { path: BETA, content: "x" } } },
      reset(),
      { at: "hook.PreToolUse", call: { name: "write_to_file", input: { content: "x" } } },
      { at: "hook.PreToolUse", call: { name: "run_commands", input: { commands: ["npm run deploy"] } } },
      { at: "hook.PreToolUse", call: { name: "run_commands", input: { commands: ["npm run check"] } } },
      { at: "hook.PreToolUse", call: { name: "submit_and_exit", input: { summary: "done", verified: true } } },
      { at: "hook.PreToolUse", call: { name: "skills", input: { command: "list" } } },
      { at: "hook.PreToolUse", call: { name: "search_codebase", input: { queries: ["alpha"] } } },
      { at: "hook.PreToolUse", call: { name: "ask_question", input: { question: "which file?" } } },
    ],
  },
  {
    name: "hook-two-native-edit-failures",
    covers: ["two consecutive native edit failures seen only by PostToolUse (cline-tool-guard.mjs:171)"],
    steps: [
      { at: "hook.PostToolUse", call: { name: "editor", id: "tc-nf-1", input: { path: ALPHA, old_text: "missing one", new_text: "x" }, output: JSON.stringify({ query: `edit:${ALPHA}`, error: "Editor operation failed: text not found", success: false }), success: false } },
      { at: "hook.PostToolUse", call: { name: "editor", id: "tc-nf-2", input: { path: ALPHA, old_text: "missing two", new_text: "y" }, output: JSON.stringify({ query: `edit:${ALPHA}`, error: "No replacement performed", success: false }), success: false } },
    ],
  },
  {
    name: "hook-post-tool-skip-dedup",
    covers: ["the PostToolUse dedup branch (cline-tool-guard.mjs:167) that must not count a plugin-skipped call as a second failure"],
    steps: [
      { at: "plugin.beforeModel", catalog: "observed" },
      editorCall({ path: KEEP, old_text: "export const KEEP = true;", new_text: "export const KEEP = false;" }, "tc-dedup"),
      { at: "hook.PostToolUse", call: { name: "editor", id: "tc-dedup", input: { path: KEEP, old_text: "export const KEEP = true;", new_text: "export const KEEP = false;" }, output: JSON.stringify({ error: "Tool call editor was rejected before execution", success: false }), success: false } },
      { at: "hook.PostToolUse", call: { name: "editor", id: "tc-dedup", input: { path: KEEP, old_text: "export const KEEP = true;", new_text: "export const KEEP = false;" }, output: JSON.stringify({ error: "Tool call editor was rejected before execution", success: false }), success: false } },
      { at: "hook.PostToolUse", call: { name: "editor", id: "tc-dedup-other", input: { path: KEEP, old_text: "nope", new_text: "x" }, output: JSON.stringify({ error: "Editor operation failed: text not found", success: false }), success: false } },
    ],
  },
  {
    name: "api-surface",
    covers: [
      "prepareToolGuard on an invalid task", "verifyRestrictedTools against a present, neutered and deleted plugin",
      "readGuardOutcome on a policy that fails validation", "readWorkerCapabilities with and without a policy",
    ],
    steps: [
      { at: "api.verifyRestrictedTools", plugin: "present" },
      { at: "api.verifyRestrictedTools", plugin: "neutered" },
      { at: "api.verifyRestrictedTools", plugin: "deleted" },
      { at: "api.readWorkerCapabilities", present: true },
      { at: "api.readWorkerCapabilities", present: false },
      { at: "api.prepareToolGuard", task: {} },
      { at: "api.prepareToolGuard", task: { id: "t", allowedPaths: [], qaCommand: "npm run check" } },
      { at: "api.prepareToolGuard", task: { id: "t", allowedPaths: ["src/alpha.ts"] } },
      { at: "api.readGuardOutcome", policy: { version: 2, stopped: false, failedEdits: 0 } },
      { at: "api.readGuardOutcome", policy: { version: 1, stopped: false, failedEdits: "0" } },
    ],
  },
];
