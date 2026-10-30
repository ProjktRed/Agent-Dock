import { redactText } from "../redact.mjs";

/**
 * Guard plan stage 1, shadow mode: every tool call as one typed record, from a registry of each adapter's native
 * tools. Nothing here decides anything yet; the hook adds the class and whether it agrees with today's guard to the
 * decision log, so the new pipeline (stages 3-5) can be compared against what really ran. A tool that isn't in the
 * registry is "unknown", an MCP tool is "mcp".
 */
export const TOOL_CLASSES = Object.freeze(["read", "edit", "command", "web", "inspect", "output", "agent", "mcp", "unknown"]);

export const TOOL_REGISTRY = Object.freeze({
  claude: {
    Read: "read", Write: "edit", Edit: "edit", MultiEdit: "edit", NotebookEdit: "edit", Bash: "command",
    Glob: "inspect", Grep: "inspect", LS: "inspect", BashOutput: "inspect", WebFetch: "web", WebSearch: "web",
    TodoWrite: "output", StructuredOutput: "output", ExitPlanMode: "output", Task: "agent",
  },
  codex: {
    Bash: "command", shell: "command", exec_command: "command", local_shell: "command", apply_patch: "edit",
    read: "read", read_file: "read", read_files: "read", view_image: "read",
    grep: "inspect", glob: "inspect", grep_files: "inspect", list_dir: "inspect", list_directory: "inspect", search_codebase: "inspect",
    update_plan: "output", request_user_input: "output", web_search: "web",
  },
  cline: {
    run_commands: "command", editor: "edit", apply_patch: "edit", read_files: "read", search_codebase: "inspect",
    ask_question: "output", submit_and_exit: "output",
  },
  opencode: {
    shell: "command", bash: "command", edit: "edit", write: "edit", patch: "edit", read: "read", glob: "inspect", grep: "inspect", question: "output",
  },
});

// Today's guard folds answer-only tools into "inspect" or "output"; both mean nothing runs and nothing changes.
const SAME = { output: ["output", "inspect"], inspect: ["inspect", "output"] };

/** The typed record of one tool call, given the adapter's own action for it. Bounded: at most 50 paths. */
export function typedAction(adapterId, action) {
  const tool = String(action?.tool ?? "");
  // Codex reports some tools with a namespace ("functions.apply_patch"): the registry keys on the last part.
  const native = tool.split(".").at(-1);
  const registry = TOOL_REGISTRY[adapterId] ?? {};
  const toolClass = tool.startsWith("mcp__") ? "mcp" : Object.hasOwn(registry, tool) ? registry[tool] : Object.hasOwn(registry, native) ? registry[native] : "unknown";
  const input = action?.input;
  const paths = (action?.kind === "edit" ? action.paths ?? [] : [input?.file_path ?? input?.path ?? input?.notebook_path]).filter((p) => typeof p === "string" && p).slice(0, 50);
  const commands = action?.kind === "command" ? (action.commands ?? []) : [];
  // Complete: the guard got everything it needs to judge the call (every command as text, every file an edit touches).
  const parseComplete = action?.error ? false
    : action?.kind === "command" ? commands.length > 0 && commands.every((c) => (typeof c === "string" ? c.trim() : c?.command))
    : action?.kind === "edit" ? paths.length > 0 && paths.length === (action.paths ?? []).length
    : true;
  const kind = action?.kind ?? "unknown";
  const agrees = kind === toolClass || (SAME[toolClass] ?? []).includes(kind) || (toolClass === "mcp" && kind === "unknown") || (toolClass === "agent" && kind === "unknown");
  return { class: toolClass, tool, known: toolClass !== "unknown", agrees, parseComplete, paths, commands: commands.length, ...(kind === "web" && typeof input?.url === "string" ? { url: redactText(input.url).slice(0, 500) } : {}) };
}
