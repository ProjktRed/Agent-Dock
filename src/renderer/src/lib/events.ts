import type { EngineEvent } from "@shared/types";
import { plural } from "./format";

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
    case "waiting-for-codex": return e.operation === "implementation" ? "Implementation waiting for the usage limit to reset (Resume to continue; its partial changes are kept)" : "Waiting for the usage limit to reset (Resume to retry)";
    case "implementation-usage-limit": return `Implementation stopped by a usage limit: ${first(e.message)}`;
    case "implementation-limit-resumed": return e.automatic ? "Trying the implementation again after the usage-limit wait" : "Continuing the implementation after Resume";
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
    case "supervisor-alert": return `Supervisor (${e.monitor ?? "alert"}): ${first(e.message)}${e.action ? ` Asked to ${e.action} at the next safe point.` : ""}`;
    case "supervisor-digest": return `Supervisor digest: ${first(e.message)}`;
    case "supervisor-review": return `Supervisor review (${e.mode ?? "propose"}): ${first(e.message)}${Array.isArray(e.actions) && e.actions.length ? " · " + e.actions.map((a: { action: string; result: string }) => `${a.action}: ${a.result}`).join("; ") : " · no action"}`;
    case "supervisor-review-failed": return `Supervisor review failed: ${first(e.message)}`;
    case "plan-proposal": return `Supervisor proposed a plan change: ${first(e.message)} Approve or dismiss it under Progress.`;
    case "plan-proposal-refused": return `Supervisor plan change refused: ${first(e.message)}`;
    case "plan-proposal-approved": return `Plan change approved: ${first(e.message)} It is committed between tasks.`;
    case "plan-proposal-dismissed": return `Plan change dismissed: ${first(e.message)}`;
    case "plan-proposal-applied": return `Plan change committed${e.commit ? ` (${String(e.commit).slice(0, 7)})` : ""}: ${first(e.message)}`;
    case "assessment-rejected": return `Assessment chose again: ${first(e.qa)}`;
    case "qa-commit-recovered": return `QA commit recovered: ${first(e.qa)}`;
    case "task-set-aside": return `Task ${e.taskId ?? ""} set aside by you: ${e.stash ? `its work is in git stash "${e.stash}"` : "it had no uncommitted work"}. The next Run starts a fresh Assessment.`;
    case "retention": return `History older than ${e.days ?? "?"} days removed: ${[e.calls ? plural(Number(e.calls), "call folder") : "", e.sessions ? plural(Number(e.sessions), "Cline session") : "", e.actionLogPruned ? plural(Number(e.actionLogPruned), "action-log archive") : "", e.activityTrimmed ? "older Activity" : "", e.actionLogRotated ? "action log archived" : ""].filter(Boolean).join(", ") || "nothing"}`;
    case "plan-item-done": return `Plan item checked off${e.commit ? ` (${String(e.commit).slice(0, 7)})` : ""}: ${first(e.message)}`;
    case "plan-tick-skipped": return `Plan item not checked off: ${first(e.message)}`;
    case "plan-proposal-failed": return `Plan change not applied: ${first(e.message)}`;
    case "remote-approval": return `Remote approval (${e.via ?? "remote"}): ${e.action ?? ""} · ${first(e.message)}`;
    case "task-approval-requested": return `Task ${e.taskId ?? ""} is waiting for your approval before Implementation starts.`;
    case "task-approved": return `Task ${e.taskId ?? ""} approved${String(e.source ?? "").startsWith("remote:") ? " remotely" : ""}: Implementation starts.`;
    case "tools-missing": return `Waiting: ${Array.isArray(e.tools) ? (e.tools as { name?: string }[]).map((t) => t.name).join(", ") : "a tool"} not installed for ${e.taskId ?? "the task"}'s check.`;
    case "tools-ready": return "The missing tool was found; Implementation starts.";
    case "tool-install-started": return `You started installing ${e.name ?? "a tool"}.`;
    case "action-decision": return `You ${e.decision === "allow-run" ? "allowed for this run" : e.decision === "allow" ? "allowed" : "refused"} an action ${e.cli ?? "the agent"} asked about.`;
    case "task-deferred": return `Task ${e.taskId ?? ""} set aside: ${first(e.reason)}${e.stash ? ` Its work is in git stash "${e.stash}" (git stash list).` : ""} Assessment chooses another task.`;
    case "parallel-round": return `Parallel round ${e.round ?? ""}: ${Array.isArray(e.tasks) ? (e.tasks as { id: string; name: string }[]).map((t) => t.name || t.id).join(", ") : ""}`;
    case "parallel-task-started": return `Task ${e.taskId ?? ""} started in its own worktree (branch ${e.branch ?? ""})`;
    case "parallel-task-finished": return `Task ${e.taskId ?? ""} finished: ${e.status ?? ""}`;
    case "parallel-merged": return `Task ${e.taskId ?? ""} merged into your branch after its check passed on the combined code${e.commit ? ` (${String(e.commit).slice(0, 7)})` : ""}`;
    case "parallel-merge-failed": return `Task ${e.taskId ?? ""} not merged: ${first(e.message)} It stays on branch ${e.branch ?? ""}.`;
    case "parallel-limit-cleared": return "No parallel task waits for a usage limit any more; the round continues";
    case "parallel-orphans-stopped": return `Stopped ${e.count === 1 ? "a task engine" : `${e.count ?? ""} task engines`} an earlier run left running before starting the next round`;
    case "task-stepped-down": return `Task ${e.taskId ?? ""} failed review twice at ${e.from ?? ""} size: set aside and redone ${e.to ?? ""}-sized.${e.stash ? ` The first attempt is in git stash "${e.stash}".` : ""}`;
    case "task-mode-restored": return `The stepped-down work is done: back to ${e.mode ?? ""} size.`;
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
    case "role-fix-started": return `${e.roleName ?? "Fixer"} is fixing what it found (guarded, task files only)`;
    case "role-fix-finished": return e.error ? `${e.roleName ?? "Fixer"} could not finish its fix: ${first(e.error)}` : `${e.roleName ?? "Fixer"} finished its fix; checking it again`;
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
