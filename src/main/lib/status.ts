import type { EngineEvent, GitInfo, PlanProgress, ProjectStatus, QaChecks, RunState } from "@shared/types";

/** Shape of the engine's live.json (engine/src/dashboard-state.mjs). Only fields the app reads. */
export interface EngineLive {
  task?: { id: string; name?: string; prompt?: string; qaCommand?: string; allowedPaths?: string[] } | null;
  stage?: string;
  clineStatus?: string;
  qaStatus?: string;
  attempt?: number;
  latestQa?: string;
  manualReview?: boolean;
  userAttention?: boolean;
  userAttentionReason?: string | null;
  blockedReason?: string | null;
  activeReasoningRole?: string | null;
  activeReasoningModel?: string | null;
  assessmentRunning?: boolean;
  elevateRunning?: boolean;
  resolverRunning?: boolean;
  codexLimitMessage?: string | null;
  codexRetryAt?: string | null;
  cline?: { startedAt?: string | null; durationMs?: number | null; pid?: number | null; contextTokens?: number | null; model?: string | null; provider?: string | null };
  qaChecks?: Partial<QaChecks>;
  updatedAt?: string;
}

export interface EngineControl {
  pauseAfterCurrent?: boolean;
  stopAfterSafePoint?: boolean;
}

/** live.json stage names from before 0.32 (engine/src/stage-names.mjs). */
const LEGACY_STAGES: Record<string, string> = { "cline-working": "implementing", "cline-complete": "implemented", "codex-qa": "qa", WAITING_FOR_CODEX: "WAITING_FOR_LIMIT" };
const stageOf = (live: EngineLive | null) => (live?.stage ? LEGACY_STAGES[live.stage] ?? live.stage : undefined);

/** Mirrors the engine dashboard's primary status (dashboard-server.mjs primaryStatus + view-model labels). */
export function deriveRunState(live: EngineLive | null, control: EngineControl, processAlive: boolean): { runState: RunState; label: string } {
  if (!live) return { runState: processAlive ? "running" : "idle", label: processAlive ? "Starting" : "Idle" };
  const stage = stageOf(live) ?? "waiting";
  if (live.resolverRunning || stage === "resolving") return { runState: "running", label: "Resolving block" };
  if (stage === "BLOCKED") return { runState: "blocked", label: "Blocked" };
  if (stage === "WAITING_FOR_LIMIT") return { runState: "waiting-limit", label: "Waiting: usage limit" };
  if (live.elevateRunning || stage === "elevating") return { runState: "running", label: "Running · Elevation" };
  if (stage === "USER_ATTENTION" || live.manualReview || stage === "manual-review") return { runState: "attention", label: "Attention required" };
  if (stage === "paused") return { runState: "paused", label: "Paused" };
  if (stage === "stopped") return { runState: "stopped", label: "Stopped" };
  if (!processAlive) {
    if (stage === "complete") return { runState: "complete", label: "Objective complete" };
    return { runState: "idle", label: "Idle" };
  }
  const role = live.assessmentRunning
    ? "Assessment"
    : live.activeReasoningRole ?? (live.clineStatus === "running" ? "Implementation" : live.qaStatus === "running" ? "QA" : null);
  if (control.stopAfterSafePoint) return { runState: "stopping", label: "Stopping at safe point" };
  if (control.pauseAfterCurrent) return { runState: "pausing", label: "Pausing after task" };
  return { runState: "running", label: role ? `Running · ${role}` : "Running" };
}

/** Which of the five cycle stages is active, for the workflow strip. */
export function cycleStage(live: EngineLive | null): "assessment" | "implementation" | "qa" | "correction" | "next" | null {
  if (!live) return null;
  if (live.assessmentRunning || live.stage === "current-task") return "assessment";
  if (live.elevateRunning || live.resolverRunning || live.stage === "elevating" || live.stage === "resolving") return "correction";
  const stage = stageOf(live);
  if (live.clineStatus === "running" || stage === "implementing" || stage === "implemented") return "implementation";
  if (live.qaStatus === "running" || stage === "qa") return "qa";
  if (live.stage === "retry" || live.stage === "fail") return "correction";
  if (live.stage === "pass" || live.stage === "complete") return "next";
  return null;
}

const defaultChecks: QaChecks = { tests: "NOT RUN", typecheck: "NOT RUN", lint: "NOT RUN", scopeCheck: "NOT RUN" };

export function buildStatus(args: {
  projectId: string;
  live: EngineLive | null;
  control: EngineControl;
  processAlive: boolean;
  pid: number | null;
  events: EngineEvent[];
  git: GitInfo;
  plan: PlanProgress;
  elevate: { available: boolean; reason: string | null };
  resolver: { available: boolean; reason: string | null };
  assessmentRetry?: boolean;
  qaRetry?: boolean;
  now?: number;
}): ProjectStatus {
  const { live, control } = args;
  const { runState, label } = deriveRunState(live, control, args.processAlive);
  const startedAt = live?.cline?.startedAt ?? null;
  const now = args.now ?? Date.now();
  const elapsed = startedAt
    ? live?.clineStatus === "running"
      ? Math.max(0, now - new Date(startedAt).getTime())
      : live?.cline?.durationMs ?? null
    : null;
  return {
    projectId: args.projectId,
    runState,
    label,
    processAlive: args.processAlive,
    pid: args.pid,
    stage: stageOf(live) ?? "waiting",
    cycle: args.processAlive || live?.stage === "pass" ? cycleStage(live) : null,
    task: live?.task ? { id: live.task.id, name: live.task.name ?? live.task.id, prompt: live.task.prompt ?? "", qaCommand: live.task.qaCommand, allowedPaths: live.task.allowedPaths } : null,
    attempt: live?.attempt ?? 0,
    activeRole: live?.assessmentRunning ? "Assessment" : live?.activeReasoningRole ?? (live?.clineStatus === "running" ? "Implementation" : null),
    activeModel: live?.activeReasoningModel ?? (live?.clineStatus === "running" ? live?.cline?.model ?? null : null),
    clineStatus: live?.clineStatus ?? "idle",
    qaStatus: live?.qaStatus ?? "waiting",
    latestQa: live?.latestQa ?? "",
    qaChecks: { ...defaultChecks, ...(live?.qaChecks ?? {}) } as QaChecks,
    clineStartedAt: startedAt,
    clineElapsedMs: elapsed,
    clineModel: live?.cline?.model ?? null,
    clineProvider: live?.cline?.provider ?? null,
    contextTokens: live?.cline?.contextTokens ?? null,
    control: { pauseAfterCurrent: Boolean(control.pauseAfterCurrent), stopAfterSafePoint: Boolean(control.stopAfterSafePoint) },
    attentionReason: live?.userAttention ? live.userAttentionReason ?? live.latestQa ?? null : null,
    blockedReason: live?.stage === "BLOCKED" ? live.blockedReason ?? live.latestQa ?? null : null,
    limitMessage: live?.codexLimitMessage ?? null,
    limitRetryAt: live?.codexRetryAt ?? null,
    elevateAvailable: args.elevate.available,
    elevateReason: args.elevate.reason,
    resolverAvailable: args.resolver.available,
    resolverReason: args.resolver.reason,
    assessmentRetry: args.assessmentRetry ?? false,
    qaRetry: args.qaRetry ?? false,
    events: args.events,
    git: args.git,
    plan: args.plan,
    updatedAt: live?.updatedAt ?? null,
  };
}

/** Engine steps by their start and finish events, named for the restart notice. */
const STEPS: [start: string, finish: string[], name: string][] = [
  ["codex-assessing", ["codex-finished"], "Assessment"],
  ["cline-started", ["cline-finished"], "Implementation"],
  ["qa-evidence-started", ["qa-evidence-finished"], "collecting check results"],
  ["codex-qa-started", ["codex-qa-finished"], "QA"],
  ["resolver-started", ["resolver-finished"], "the Resolver"],
  ["sol-reassessment-started", ["sol-reassessment-finished"], "Elevation"],
  ["role-started", ["role-result", "role-error"], "a workflow role"],
];
/** Events after which the engine has stopped on purpose or waits for the user. */
const RESTING = new Set(["stopped", "paused", "loop-complete", "blocked", "user-attention", "correction-limit", "waiting-for-codex", "codex-usage-limit"]);

/**
 * Whether a project's engine stopped in the middle of its work (crash, reboot, killed process),
 * as opposed to stopping on purpose or resting between tasks. Returns what was interrupted, or
 * null. Decided from the activity log, not the stage: the stage stays "current-task" while the
 * engine rests after an approved task.
 */
export function interruptedWork(status: Pick<ProjectStatus, "processAlive" | "runState" | "events">): string | null {
  if (status.processAlive || ["paused", "stopped", "blocked", "attention", "waiting-limit", "complete"].includes(status.runState)) return null;
  const open = new Map<string, string>();
  for (const e of status.events) {
    if (RESTING.has(e.type)) open.clear();
    for (const [start, finish, name] of STEPS) {
      if (e.type === start) open.set(start, name);
      else if (finish.includes(e.type)) open.delete(start);
    }
  }
  return [...open.values()].pop() ?? null;
}
