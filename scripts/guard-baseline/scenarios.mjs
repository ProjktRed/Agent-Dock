// The synthetic task and the scripted Cline turns the stub serves, one scenario
// per Cline process. `{{WS}}` is replaced with the throwaway workspace path when
// the scenario is written for the stub (Cline's editor/read_files take absolute paths).

export const TASK = {
  id: "guard-baseline",
  name: "Guard baseline probe",
  prompt: "Apply the guard baseline probe edits.",
  qaCommand: "npm run check",
  allowedPaths: ["src/alpha.ts", "src/inscope/"],
};

export const SEED_FILES = {
  "package.json": JSON.stringify({ name: "guard-baseline-fixture", private: true, version: "0.0.0", scripts: { check: "node -e \"console.log('check ok')\"", lint: "node -e \"console.log('lint ok')\"", typecheck: "node -e \"console.log('typecheck ok')\"" } }, null, 2) + "\n",
  "src/alpha.ts": "export const ALPHA_VERSION = 1;\nexport function alpha(): string {\n  return \"alpha\";\n}\n",
  "src/beta.ts": "export const BETA_VERSION = 1;\n",
  "src/inscope/keep.ts": "export const KEEP = true;\n",
};

const submit = (summary) => ({ name: "submit_and_exit", arguments: { summary, verified: true } });

export const SCENARIOS = [
  {
    name: "in-scope-edit-approved-command-complete",
    covers: ["edit inside allowedPaths", "approved qaCommand", "read_files then in-range replacement", "final completion"],
    model: "stub-model",
    turns: [
      { content: "Creating the in-scope file.", toolCalls: [{ name: "editor", arguments: { path: "{{WS}}/src/inscope/new-file.ts", new_text: "export const NEW = 1;\n" } }] },
      { content: "Running the task QA command.", toolCalls: [{ name: "run_commands", arguments: { commands: ["npm run check"] } }] },
      { content: "Reading the file before editing.", toolCalls: [{ name: "read_files", arguments: { files: [{ path: "{{WS}}/src/alpha.ts" }] } }] },
      { content: "Bumping the version constant.", toolCalls: [{ name: "editor", arguments: { path: "{{WS}}/src/alpha.ts", old_text: "export const ALPHA_VERSION = 1;", new_text: "export const ALPHA_VERSION = 2;" } }] },
      { content: "Submitting.", toolCalls: [submit("Created the in-scope file, ran the QA command and bumped the alpha version constant.")] },
      { content: "Done.", finish: "stop" },
    ],
  },
  {
    name: "out-of-scope-edit",
    covers: ["edit outside allowedPaths"],
    model: "stub-model",
    turns: [
      { content: "Editing a file outside the task scope.", toolCalls: [{ name: "editor", arguments: { path: "{{WS}}/src/beta.ts", old_text: "export const BETA_VERSION = 1;", new_text: "export const BETA_VERSION = 2;" } }] },
      { content: "Stopping.", finish: "stop" },
    ],
  },
  {
    name: "unsafe-command",
    covers: ["blocked command (file-hook hard stop)"],
    model: "stub-model",
    turns: [
      { content: "Pushing the branch.", toolCalls: [{ name: "run_commands", arguments: { commands: ["git push origin main"] } }] },
      { content: "Stopping.", finish: "stop" },
    ],
  },
  {
    name: "unapproved-command",
    covers: ["unapproved command (soft reject, three strikes)"],
    model: "stub-model",
    turns: [
      { content: "Deploying.", toolCalls: [{ name: "run_commands", arguments: { commands: ["npm run deploy"] } }] },
      { content: "Releasing.", toolCalls: [{ name: "run_commands", arguments: { commands: ["npm run release"] } }] },
      { content: "Shipping.", toolCalls: [{ name: "run_commands", arguments: { commands: ["npm run ship"] } }] },
      { content: "Stopping.", finish: "stop" },
    ],
  },
  {
    name: "unknown-tool",
    covers: ["unknown/unregistered tool"],
    model: "stub-model",
    turns: [
      { content: "Writing the file directly.", toolCalls: [{ name: "write_to_file", arguments: { path: "{{WS}}/src/beta.ts", content: "export const BETA_VERSION = 3;\n" } }] },
      { content: "Searching the web.", toolCalls: [{ name: "web_search", arguments: { query: "typescript const" } }] },
      { content: "Spawning an agent.", toolCalls: [{ name: "spawn_agent", arguments: { task: "edit beta" } }] },
      { content: "Stopping.", finish: "stop" },
    ],
  },
  {
    name: "two-failed-edits",
    covers: ["two consecutive failing edits"],
    model: "stub-model",
    turns: [
      { content: "Editing without reading first.", toolCalls: [{ name: "editor", arguments: { path: "{{WS}}/src/alpha.ts", old_text: "return \"alpha\";", new_text: "return \"alpha2\";" } }] },
      { content: "Trying a different replacement.", toolCalls: [{ name: "editor", arguments: { path: "{{WS}}/src/alpha.ts", old_text: "export function alpha(): string {", new_text: "export function alpha2(): string {" } }] },
      { content: "Stopping.", finish: "stop" },
    ],
  },
];

export function materializeScenario(scenario, workspace) {
  return JSON.parse(JSON.stringify(scenario).replaceAll("{{WS}}", workspace.replaceAll("\\", "\\\\")));
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// Part 1 additions. Everything above is the original recording surface and is unchanged.
// ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * cline-tool-guard.mjs:12. Duplicated here on purpose: it is the fixture the recorded
 * `beforeModel` control is checked against, not a value read out of the module under test.
 */
export const GUARD_ALLOWED_TOOLS = [
  "read_files", "search_codebase", "run_commands", "editor", "apply_patch", "skills", "ask_question", "submit_and_exit",
];

/**
 * Two more model scenarios: `npx prettier --write` is the only write-capable approved command
 * (cline-tool-guard.mjs:142-143), so both sides of its path check need recording.
 */
export const EXTRA_SCENARIOS = [
  {
    name: "prettier-write-in-scope",
    covers: ["npx prettier --write on an in-scope existing file (approved)"],
    model: "stub-model",
    turns: [
      { content: "Formatting the in-scope file.", toolCalls: [{ name: "run_commands", arguments: { commands: ["npx prettier --write src/alpha.ts"] } }] },
      { content: "Done.", finish: "stop" },
    ],
  },
  {
    name: "prettier-write-out-of-scope",
    covers: ["npx prettier --write on an out-of-scope file (denied; prettier --write is an unsafe command)"],
    model: "stub-model",
    turns: [
      { content: "Formatting another file.", toolCalls: [{ name: "run_commands", arguments: { commands: ["npx prettier --write src/beta.ts"] } }] },
      { content: "Stopping.", finish: "stop" },
    ],
  },
];

/** All model-driven scenarios: expanded into plugin + file-hook steps by lib/runner.mjs. */
export const MODEL_SCENARIOS = [...SCENARIOS, ...EXTRA_SCENARIOS];
