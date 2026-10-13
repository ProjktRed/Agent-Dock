// The reason-string contract, frozen. Every denial/cancel/throw string the guard surface can
// produce today, quoted verbatim from the module and line named in `source`.
//
// `how` says how Part 1 proves the string:
//   "recorded"       — it must appear in a recorded decision/control/strings.json of the Tier A run.
//                      capture.mjs fails if it does not.
//   "source-literal" — it cannot be produced without a real Cline/Codex process doing something a
//                      stub cannot make it do, so capture.mjs instead asserts the literal is still
//                      present in `file`. Weaker, and listed as such in the report.
//
// `recoverable: true` marks the three strings blocked-resolver.mjs:77 regex-matches to decide that
// a blocked run can recover automatically. Those three are the reason Part 1 exists.

/**
 * The exact prefix cline-cli-worker.mjs:564 composes a stopped guard attempt from. lib/derive.mjs
 * imports it instead of restating the format, so the harness has exactly one place that claims to
 * know this string — and that place is checked against the worker's own source below.
 */
export const STOP_MESSAGE_PREFIX = "Cline editing guard stopped attempt: ";

export const REASONS = [
  // ── engine/src/cline-tool-guard.mjs ────────────────────────────────────────────────────────
  { id: "prepare-invalid-task", source: "cline-tool-guard.mjs:17", how: "recorded", kind: "throw",
    text: "Cline editing guard requires valid current task/scope" },
  { id: "missing-command-choices", source: "cline-tool-guard.mjs:53", how: "recorded", kind: "throw",
    text: "missing command choices" },
  { id: "handshake-missing", source: "cline-tool-guard.mjs:75", how: "recorded", kind: "throw",
    text: "tool restriction handshake missing" },
  { id: "command-safety-failed", source: "cline-tool-guard.mjs:80", how: "recorded", kind: "stop",
    text: "command safety validation failed" },
  { id: "unsafe-command", source: "cline-tool-guard.mjs:82", how: "recorded", kind: "stop",
    text: "unsafe command is prohibited" },
  { id: "unapproved-tool-path", source: "cline-tool-guard.mjs:86", how: "recorded", kind: "stop",
    text: "unapproved tool path is outside approved scope" },
  { id: "two-edit-failures-plugin", source: "cline-tool-guard.mjs:97", how: "recorded", kind: "stop", recoverable: true,
    text: "two consecutive native edit failures; preserve the diff and reassess" },
  { id: "soft-reject", source: "cline-tool-guard.mjs:110", how: "recorded", kind: "reject",
    text: "Tool/command not approved. Use only the visible native tools and select an exact run_commands.commands enum value." },
  { id: "three-invalid-requests", source: "cline-tool-guard.mjs:111", how: "recorded", kind: "stop",
    text: "three invalid tool requests; preserve the diff and reassess" },
  { id: "plugin-unavailable", source: "cline-tool-guard.mjs:115", how: "recorded", kind: "throw",
    text: "Cline tool restriction plugin unavailable" },
  { id: "malformed-hook-input", source: "cline-tool-guard.mjs:159", how: "recorded", kind: "cancel",
    text: "malformed hook input" },
  { id: "missing-tool-identity", source: "cline-tool-guard.mjs:161", how: "recorded", kind: "cancel",
    text: "missing tool identity" },
  { id: "two-edit-failures-hook", source: "cline-tool-guard.mjs:171", how: "recorded", kind: "cancel", recoverable: true,
    text: "two consecutive native edit failures; preserve the diff and reassess" },
  { id: "missing-tool-input", source: "cline-tool-guard.mjs:176", how: "recorded", kind: "cancel",
    text: "missing tool input" },
  { id: "edit-path-outside", source: "cline-tool-guard.mjs:177", how: "recorded", kind: "cancel",
    text: "edit path is outside approved scope or unresolved" },
  { id: "malformed-patch", source: "cline-tool-guard.mjs:179", how: "recorded", kind: "cancel",
    text: "malformed patch" },
  { id: "patch-paths-not-explicit", source: "cline-tool-guard.mjs:181", how: "recorded", kind: "cancel",
    text: "patch paths are not explicit" },
  { id: "patch-path-outside", source: "cline-tool-guard.mjs:182", how: "recorded", kind: "cancel",
    text: "patch path is outside approved scope" },
  { id: "command-not-approved", source: "cline-tool-guard.mjs:190", how: "recorded", kind: "cancel", recoverable: true,
    text: "command is not approved validation/read-only inspection; use native editing tools, not shell writes" },
  { id: "unknown-tool", source: "cline-tool-guard.mjs:194", how: "recorded", kind: "cancel", recoverable: true,
    text: "unknown or unapproved tool: " },
  { id: "lock-unresolved", source: "cline-tool-guard.mjs:204", how: "recorded", kind: "cancel",
    text: "guard counter lock is unresolved" },
  { id: "invalid-guard-policy", source: "cline-tool-guard.mjs:206", how: "recorded", kind: "throw",
    text: "invalid guard policy" },
  { id: "guard-state-unavailable", source: "cline-tool-guard.mjs:210", how: "recorded", kind: "cancel",
    text: "guard state unavailable: " },
  { id: "invalid-outcome-policy", source: "cline-tool-guard.mjs:224", how: "recorded", kind: "throw",
    text: "Invalid Cline editing guard policy" },
  { id: "oversized-hook-input", source: "cline-tool-guard.mjs:232", how: "recorded", kind: "cancel",
    text: "oversized hook input" },
  { id: "cancel-prefix", source: "cline-tool-guard.mjs:10", how: "recorded", kind: "prefix",
    text: "Cline editing guard: " },

  // ── engine/src/cline-edit-boundary.mjs ─────────────────────────────────────────────────────
  { id: "source-too-large", source: "cline-edit-boundary.mjs:13", how: "recorded", kind: "throw",
    text: "Read/edit source must be a text file below 1 MB" },
  { id: "identical-failed-edit", source: "cline-edit-boundary.mjs:36", how: "recorded", kind: "reject",
    text: "Identical failed edit already attempted. Use its saved error and reread before proposing a different small edit." },
  { id: "patch-too-large", source: "cline-edit-boundary.mjs:38", how: "recorded", kind: "reject",
    text: "Patch must be at most 4000 characters. Split into small changes." },
  { id: "patch-stale-read", source: "cline-edit-boundary.mjs:40", how: "recorded", kind: "reject",
    text: "Read each affected file with read_files before applying a patch; current file differs from the last successful read." },
  { id: "native-edit-size", source: "cline-edit-boundary.mjs:43", how: "recorded", kind: "reject",
    text: "Native edit requires new_text and at most 2000 characters per old_text/new_text. Split the edit." },
  { id: "file-missing-replacement", source: "cline-edit-boundary.mjs:45", how: "recorded", kind: "reject",
    text: "File does not exist; replacement/insertion is unavailable." },
  { id: "whole-file-rewrite", source: "cline-edit-boundary.mjs:46", how: "recorded", kind: "reject",
    text: "Whole-file rewrite of an existing file is prohibited. Use a small exact replacement or verified line insertion." },
  { id: "fresh-read-required", source: "cline-edit-boundary.mjs:48", how: "recorded", kind: "reject",
    text: "Fresh read required: use read_files on the intended edit range; file is unread or changed since read." },
  { id: "one-edit-mode", source: "cline-edit-boundary.mjs:51", how: "recorded", kind: "reject",
    text: "Use one edit mode with nonempty old_text for replacement." },
  { id: "old-text-not-unique", source: "cline-edit-boundary.mjs:53", how: "recorded", kind: "reject",
    text: "old_text must match exactly once in the current file. Reread a small range and use unique context; do not reconstruct escaped literals." },
  { id: "replacement-outside-range", source: "cline-edit-boundary.mjs:55", how: "recorded", kind: "reject",
    text: "Replacement extends outside the successfully read range. Read that range first." },
  { id: "insert-line-outside", source: "cline-edit-boundary.mjs:56", how: "recorded", kind: "reject",
    text: "Insertion line must be inside or immediately after the freshly read range." },

  // ── engine/src/cline-cli-worker.mjs (worker-composed, not guard-produced) ──────────────────
  // Deliberately not "recorded". The worker composes this string only when a real guarded attempt
  // stops, which no Tier A step and no stub-driven Cline run reaches; the only reason it appears in
  // a recording at all is `strings.json.reasons[].stopMessage`, which lib/derive.mjs composes from
  // STOP_MESSAGE_PREFIX — this entry's own text. Proving it that way would prove the harness
  // consistent with itself. Asserting the literal in the worker is what makes an edit to
  // cline-cli-worker.mjs:564 fail the inventory.
  { id: "stop-message", source: "cline-cli-worker.mjs:564", how: "source-literal", kind: "compose",
    file: "engine/src/guard/reasons.mjs",
    text: STOP_MESSAGE_PREFIX },
  { id: "runtime-not-ready", source: "cline-cli-worker.mjs:435", how: "source-literal", kind: "throw",
    file: "engine/src/guard/reasons.mjs",
    text: "Cline tool restriction plugin did not initialize; guarded completion refused" },
  { id: "attempt-not-completed", source: "cline-cli-worker.mjs:567", how: "source-literal", kind: "throw",
    file: "engine/src/guard/reasons.mjs",
    text: "Guarded Cline attempt did not complete: " },

  // ── engine/src/codex-scope-guard.mjs — the Codex rail. Deliberately NOT recoverable. ───────
  { id: "codex-patch-no-files", source: "codex-scope-guard.mjs:72", how: "recorded", kind: "codex-deny",
    text: "The patch names no files; only the task's approved paths may change." },
  { id: "codex-outside-paths", source: "codex-scope-guard.mjs:74", how: "recorded", kind: "codex-deny",
    text: "Outside the task's approved paths: " },
  { id: "codex-must-be-patch", source: "codex-scope-guard.mjs:76", how: "recorded", kind: "codex-deny",
    text: "File changes must be a patch on the task's approved paths." },
  { id: "codex-shell-denied", source: "codex-scope-guard.mjs:80", how: "recorded", kind: "codex-deny",
    text: "Tool guard: only the task's check (" },
  { id: "codex-mcp-denied", source: "codex-scope-guard.mjs:82", how: "recorded", kind: "codex-deny",
    text: "Tool guard: MCP tools are not available to the implementation worker." },
  { id: "codex-hook-error", source: "codex-scope-hook.mjs:20", how: "recorded", kind: "codex-deny",
    text: "Scope hook could not check this call (" },
  { id: "codex-fail-closed", source: "cloud-impl-worker.mjs:167", how: "source-literal", kind: "throw",
    file: "engine/src/guard/reasons.mjs",
    text: "Codex ran tools without the scope hook (hooks disabled or not loaded); the attempt is refused. Check that Codex hooks are enabled (codex features list)." },
];

/** The three strings blocked-resolver.mjs:77 treats as automatically recoverable. */
export const RECOVERABLE_IDS = REASONS.filter((reason) => reason.recoverable).map((reason) => reason.id);

/** Reason texts that must classify as NOT recoverable, asserted by capture.mjs. */
export const MUST_NOT_RECOVER = [
  "edit path is outside approved scope or unresolved",
  "unsafe command is prohibited",
  "three invalid tool requests; preserve the diff and reassess",
  "command safety validation failed",
  "unapproved tool path is outside approved scope",
  "patch path is outside approved scope",
];
