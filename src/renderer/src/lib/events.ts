import type { EngineEvent } from "@shared/types";

const first = (value: unknown, max = 160) => String(value ?? "").split(/\r?\n/).find((l) => l.trim())?.trim().slice(0, max) ?? "";
const attemptOf = (e: EngineEvent) => (e.attempt != null && e.attempt > 1 ? ` (attempt ${e.attempt})` : "");
const model = (e: EngineEvent) => (e.model ? ` · ${e.model}` : "");
const seconds = (ms: unknown) => (typeof ms === "number" ? ` in ${Math.round(ms / 1000)} s` : "");

const COMPACTION_TEXT = /^auto-compact(?:ing|ed|ion-skipped)$/;
const HIDDEN = new Set(["cline-compaction", "cline-provider-metrics", "cline-message-delta", "recovery-state"]);

/**
 * Bookkeeping that is not activity: context compaction notices (counted on the Token tab), token
 * samples and internal state snapshots. Older logs carry compaction as plain worker messages.
 */
export function isHiddenEvent(e: EngineEvent): boolean {
  return HIDDEN.has(e.type) || (e.type === "cline-message" && COMPACTION_TEXT.test(String(e.message ?? e.action ?? "").trim()));
}

/**
 * One readable line per engine event. Orchestrator steps are named by role, not by the internal
 * "codex-*" event names (the same events are written when a role runs on Claude Code).
 */
export function describeEvent(e: EngineEvent): string {
  switch (e.type) {
    case "codex-assessing": return `Assessment: choosing the next task${model(e)}`;
    case "codex-finished": return "Assessment finished";
    case "codex-operation-consumed": return "Discarded the stored Assessment result; asking Assessment again";
    case "codex-qa-started": return `QA: reviewing the change${attemptOf(e)}${model(e)}`;
    case "codex-qa-finished": return `QA finished${seconds(e.durationMs)}`;
    case "sol-reassessment-started": return `Elevation: reassessing the strategy${model(e)}`;
    case "sol-reassessment-finished": return "Elevation finished";
    case "resolver-started": return `Resolver: analysing the block${model(e)}`;
    case "resolver-finished": return "Resolver finished";
    case "codex-usage-limit": return `Usage limit reached: ${first(e.message)}`;
    case "orchestrator-fallback": {
      const role = ({ qa: "QA", assessment: "Assessment", resolver: "Resolver", elevate: "Elevation" } as Record<string, string>)[String(e.role)] ?? "Orchestrator";
      const cli = (value: unknown) => value === "claude" ? "Claude Code" : "Codex";
      return `${role}: usage limit on ${cli(e.fromCli)}; retrying on ${cli(e.toCli)}${model(e)}`;
    }
    case "waiting-for-codex": return "Waiting for the usage limit to reset (Resume to retry)";
    case "task-loaded": return `Task loaded: ${e.taskId ?? ""}${Array.isArray(e.skills) && e.skills.length ? ` · skills: ${e.skills.join(", ")}` : ""}`;
    case "known-issues-selected": return Array.isArray(e.knownIssues) && e.knownIssues.length ? `Known worker issues included: ${e.knownIssues.join(", ")}` : "No known worker issues apply";
    case "cline-started": return `Implementation started${attemptOf(e)}`;
    case "cline-provider-ready": return `Implementation model ready${model(e)}`;
    case "implementation-cli-ready": return `Implementation on ${e.cli === "claude" ? "Claude Code" : "Codex"}${model(e)}`;
    case "cline-process-started": return "Implementation worker running";
    case "cline-finished": return `Implementation finished${seconds(e.durationMs)}${typeof e.exitCode === "number" && e.exitCode !== 0 ? ` (exit ${e.exitCode})` : ""}`;
    case "cline-thinking": return "Worker: thinking…";
    case "cline-file-read":
    case "cline-file-modified":
    case "cline-command":
    case "cline-search":
    case "cline-tool":
    case "cline-tool-failed": return `Worker: ${first(e.action)}`;
    case "cline-message": return `Worker says: ${first(e.message)}`;
    case "cline-guard-stopped": return `Tool guard stopped the attempt: ${first(e.message)}`;
    case "implementation-scope-blocked": return `Scope hook blocked ${e.tool ?? "a tool"}: ${first(e.reason)}`;
    case "qa-evidence-started": return "Collecting check results";
    case "qa-evidence-finished": return `Checks collected · ${e.changedFileCount ?? 0} changed file${e.changedFileCount === 1 ? "" : "s"}`;
    case "qa-pass": return `QA passed: ${first(e.qa)}`;
    case "qa-retry": return `Retry QA: reviewing attempt ${e.attempt ?? "?"} again with fresh check results`;
    case "run-limit": return `Run limit reached: ${first(e.message)} Stopping at the next safe point.`;
    case "qa-environment-retry": return `QA could not run its tools (environment, not the code); retrying once: ${first(e.qa, 120)}`;
    case "cline-stalled": return `Worker ended early: ${first(e.message)}`;
    case "qa-fail": return `QA found problems: ${first(e.qa)}`;
    case "retry": return `Correction sent to the worker (attempt ${e.attempt ?? "?"})`;
    case "elevate-result": return "Elevation proposed a revised strategy";
    case "correction-limit": return `Correction limit reached (${e.limit ?? "?"})`;
    case "user-attention": return `Needs your attention: ${first(e.qa)}`;
    case "blocked": return `Blocked: ${first(e.qa)}`;
    case "role-started": return `${e.roleName ?? "Workflow role"}: started${model(e)}`;
    case "role-result": return `${e.roleName ?? "Workflow role"}: ${e.verdict === "changes-needed" ? "changes needed" : "ok"}${e.summary ? ` · ${first(e.summary, 120)}` : ""}`;
    case "role-error": return `${e.roleName ?? "Workflow role"} could not run: ${first(e.message)}`;
    case "role-gate-failed": return `${e.roleName ?? "Gate"} sent the change back for correction`;
    case "loop-complete": return "Objective complete";
    case "paused": return "Paused";
    case "stopped": return "Stopped";
    case "queued": return "Waiting for the worker to be free";
    default: {
      if (e.type.startsWith("control-")) return `You requested: ${e.type.slice(8).replace(/-/g, " ")}`;
      const detail = e.message ?? e.qa ?? "";
      return `${e.type}${detail ? ` · ${first(detail)}` : ""}`;
    }
  }
}
