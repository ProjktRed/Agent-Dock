// Types shared between the Electron main process, preload bridge and renderer.

export type Role = "implementation" | "qa" | "assessment" | "elevation" | "custom";
export type CliKind = "codex" | "cline" | "claude" | "opencode" | "ollama" | "llamacpp" | "openai";
export type ConnectionState =
  | "connected"
  | "disconnected"
  | "auth-required"
  | "not-found"
  | "unavailable"
  | "rate-limited"
  | "unchecked"
  | "checking";

/** Where a displayed value came from. Never shown as "reported" unless a tool returned it. */
export type Provenance = "reported" | "estimated" | "manual" | "not-exposed" | "unavailable" | "not-applicable";

export interface Project {
  id: string;
  name: string;
  path: string;
  repoUrl: string | null;
  objective: string;
  description: string;
  createdAt: string;
  archived: boolean;
  /** Engine state directory. Defaults to an app-managed folder; can point at an existing run. */
  stateDir: string;
  roleOverrides: Partial<Record<Exclude<Role, "custom">, string>>;
  workflowOverrides: Partial<WorkflowSettings>;
  /** Optional first task (engine --task JSON). Used once, then cleared. */
  pendingTaskFile?: string | null;
  /** Scheduled runs: start automatically at a local time on chosen weekdays while the app is open. */
  schedule?: ProjectSchedule;
  /** The last scheduled start slot (ISO), so each slot starts at most once. */
  lastScheduledStart?: string | null;
  /** Pull-request mode: runs work on an agent-dock/ branch; Open pull request pushes it. */
  prMode?: boolean;
  /** The branch the current run branch was made from (the pull request's base). */
  prBase?: string | null;
  /** GitHub CI: the pushed run branch whose GitHub Actions runs the app watches, set when the app pushes it. */
  ci?: CiWatch | null;
  /** GitHub CI fix loop (off by default): a failed CI run starts a run that fixes it, then pushes the branch again. */
  ciFixLoop?: boolean;
  /** One-shot note added to the objective on the next start: the failed CI log to fix. Cleared once started. */
  ciNote?: string | null;
  /** Parallel lane: the project this worktree lane belongs to, and the lane's branch. */
  parentId?: string | null;
  laneBranch?: string | null;
  /** Opt-in WSL isolation: the engine and its agent CLIs run inside this WSL distro. */
  wsl?: { enabled: boolean; distro: string };
}

/** A pushed run branch and commit whose GitHub Actions runs the app reads with GitHub CLI. */
export interface CiWatch {
  repo: string;
  branch: string;
  sha: string;
  pushedAt: string;
  prUrl: string | null;
  /** The last summary seen; a final one (pass, fail, cancelled) ends the polling for this commit. */
  state: CiState;
  /** Fix-loop runs started for this branch since the last push you made; at most CI_FIX_MAX. */
  fixAttempts: number;
  /** A fix-loop run is working; when it ends with new commits the branch is pushed again. */
  fixing: boolean;
}

export type CiState = "pending" | "pass" | "fail" | "cancelled" | "none" | "unavailable";
export type CiBucket = "pass" | "fail" | "pending" | "skipping" | "cancel";
export interface CiCheck { id: number; name: string; workflow: string; bucket: CiBucket; url: string | null }
export interface CiStatus {
  projectId: string;
  watch: CiWatch | null;
  state: CiState;
  checks: CiCheck[];
  /** Why the state is unavailable or none, in words. */
  message: string | null;
  checkedAt: string | null;
}

export interface ProjectSchedule {
  enabled: boolean;
  /** "HH:MM", 24-hour local time. */
  time: string;
  /** 0 = Sunday … 6 = Saturday. */
  days: number[];
  /** Windows: also start while Agent Dock is closed (a per-user Task Scheduler task launches it). */
  whenClosed?: boolean;
  /** Windows, with whenClosed: Task Scheduler may wake the PC from sleep for the start. Off by default. */
  wakeToRun?: boolean;
}

export interface Agent {
  id: string;
  name: string;
  role: Role;
  customRole?: string;
  cliId: string;
  /** Optional agent on the other orchestrator CLI, tried once when this role reaches a usage limit. */
  backupAgentId?: string;
  /** Provider selected for a Cline or OpenCode implementation worker; custom Cline roles use local providers. */
  provider?: "llamacpp" | "ollama" | "openai";
  /** Specific OpenAI-compatible connection used by an implementation worker. */
  providerCliId?: string;
  model: string;
  reasoning?: string;
  /** Orchestrator agents: run on the CLI's Fast speed tier (Codex service tier priority, Claude fast mode). */
  fast?: boolean;
  contextTokens: number;
  maxOutputTokens: number;
  timeoutSeconds: number;
  instructions: string;
  skills: string[];
  /** Implementation agents: skills Assessment may pick per task by their descriptions ("when relevant"). */
  autoSkills?: string[];
  /** Implementation agents: Assessment may pick from every imported, enabled skill (default on). */
  autoAllImported?: boolean;
  enabled: boolean;
}

export interface CliConnection {
  id: string;
  kind: CliKind;
  name: string;
  /** Executable path/command for CLIs, base URL for HTTP runtimes. */
  location: string;
  builtIn: boolean;
  startupTimeoutSeconds: number;
  requestTimeoutSeconds: number;
  contextCap: number | null;
  defaultModel: string | null;
  manualModels: string[];
  env: { key: string; value: string; secret: boolean }[];
  hasSecret: boolean;
  /** llama.cpp only: serve every model in this folder (router mode, opt-in). Null keeps the launcher's single model. */
  modelsDir?: string | null;
  /** Ollama only: requests it answers at once (its OLLAMA_NUM_PARALLEL), the most parallel tasks it gets. Default 1. */
  parallelRequests?: number;
  /** Codex CLI / Claude Code only: per-run settings (CLIs › Settings), checked against src/shared/cli-settings.ts. */
  runSettings?: Record<string, string | number | boolean>;
  /** Local providers: the model list last collected from the provider itself (Models tab › Refresh). */
  collected?: CollectedModels | null;
}

export interface CollectedModel {
  id: string;
  detail: string;
  contextTokens: number | null;
  /** The provider reports thinking support (Ollama capabilities); null when it does not say. */
  thinking: boolean | null;
}

export interface CollectedModels {
  at: string;
  source: string;
  models: CollectedModel[];
  error: string | null;
}

export interface Capability {
  name: string;
  state: "detected" | "partial" | "unsupported" | "unknown";
  detail: string;
}

export interface CliHealth {
  id: string;
  state: ConnectionState;
  detail: string;
  version: string | null;
  resolvedPath: string | null;
  auth: { state: "ok" | "required" | "not-required" | "unknown"; detail: string };
  models: { id: string; detail: string; contextTokens: number | null }[];
  contextMax: { value: number | null; provenance: Provenance; source: string };
  capabilities: Capability[];
  latencyMs: number | null;
  checkedAt: string | null;
  log: string[];
}

export interface WorkflowSettings {
  autoContinue: boolean;
  /** Maps to the engine's --sol-reassessment flag (automatic Elevation on manual review). */
  automaticElevation: boolean;
  /** Maps to the engine's --tool-guard flag. */
  toolGuard: boolean;
  resumeAfterRestart: "ask" | "auto" | "paused";
  stopAfterCurrentTask: boolean;
  /** Unattended mode: guards locked on, automatic continuation, and run-wide limits the engine enforces. */
  unattended: boolean;
  /** 0 = no limit, except corrections, which always need a limit when unattended. Token budgets are in millions;
   *  spend budgets in USD count what the CLIs report, plus estimates from `prices` for CLIs that report none (Codex). */
  unattendedLimits: {
    maxTasks: number; maxHours: number; maxCorrections: number; maxElevations: number;
    maxMillionTokens?: number; maxCostUsd?: number; maxMillionTokensDay?: number; maxCostUsdDay?: number;
  };
  /** Price table for spend: USD per million tokens. A model ending in * matches by prefix. */
  prices?: ModelPrice[];
  /** Task size (engine --task-mode): eco splits plan items into small tasks, standard does one plan item per task,
   *  max has no fixed size apart from maxLimits. */
  taskMode?: TaskMode;
  /** Standard or max: a task that fails review twice is set aside and redone one size smaller (default on). */
  stepDown?: boolean;
  /** Max mode's own limits (Max limits in the sidebar); 0 = no limit. */
  maxLimits?: MaxLimits;
  /** Tasks run side by side in one run, each in its own git worktree (engine --parallel); 1 = one at a time. */
  parallelTasks?: number;
  /** Supervisor v1: deterministic monitors; may alert, and pause or stop when allowed. */
  supervisor?: SupervisorSettings;
}

export type TaskMode = "eco" | "standard" | "max";
export interface MaxLimits { files: number; newLines: number; readFiles: number; timeoutMinutes: number }

/** One model's price in USD per million tokens; cachedInput is for input read from a prompt cache. */
export interface ModelPrice { model: string; input: number; cachedInput: number; output: number }

export interface SupervisorSettings {
  /** off: no monitors · alert: alerts only · pause / stop: alerts, and serious ones pause or stop the run at the next safe point. */
  mode: "off" | "alert" | "pause" | "stop";
  /** Each threshold 0 = that monitor off. */
  stallMinutes: number;
  repeatFailures: number;
  refusals: number;
  millionTokensPerTask: number;
  planDrift: number;
  scopePaths: number;
  digestHours: number;
  /** v2: a model reviews each alert. propose: actions are suggestions; act: allowed actions are carried out. */
  review?: "off" | "propose" | "act";
  /** auto = the orchestrator's CLI (Codex or Claude Code). local = an OpenAI-compatible server at reviewerBaseUrl. */
  reviewer?: "auto" | "codex" | "claude" | "local";
  reviewerModel?: string;
  reviewerBaseUrl?: string;
  /** Owner's choice: the Supervisor may set a stuck task aside (its work stashed) and continue with another. */
  mayDefer?: boolean;
  reviewMax?: number;
  /** The review may propose IMPLEMENTATION_PLAN.md edits; each one waits for your approval. */
  planProposals?: boolean;
}

export interface AttentionPolicy {
  informational: "in-app" | "windows" | "off";
  recommendPause: "in-app" | "windows";
  mandatory: "windows";
  blocker: "windows";
}

export type UiStyle = "neumorphic" | "standard" | "cyberpunk";

export interface Settings {
  general: {
    launchAtStartup: boolean;
    startMinimized: boolean;
    keepInTray: boolean;
    /** Interface style; theme (Dark/Darker) applies to every style. */
    style: UiStyle;
    theme: "dark" | "darker";
    /** The Neumorphic accent (the original look, so older settings keep theirs). */
    accent: string;
    /** The accent remembered for each of the other styles. */
    styleAccents: { standard: string; cyberpunk: string };
    notifyCompleted: boolean;
    notifyErrors: boolean;
    notifyInfo: boolean;
    /** Remote channels (webhook / Discord URLs are stored encrypted as secrets); digests can be left out. */
    notifyDigests?: boolean;
    /** Send signed approval requests to Telegram/email when a run waits for you (the app must be running). */
    remoteApprovals?: boolean;
    /** Keep per-call folders, Cline sessions and log archives this many days (the newest are always kept); 0 = forever. */
    retentionDays?: number;
    defaultProject: string;
  };
  workflow: WorkflowSettings;
  attention: AttentionPolicy;
  context: {
    warnThresholdPercent: number;
  };
  safety: {
    protectedPaths: string[];
    /** TOOL_CONFIG_PATHS were added to these settings once (a path removed later stays removed). */
    toolConfigPathsAdded?: boolean;
  };
  usage: {
    manualBudgets: { provider: string; label: string; limit: number; unit: "tokens" | "usd" }[];
    /** Codex limits are read for free; 0 = only on demand. */
    codexPollMinutes: number;
    /** Claude Code get_usage polling (free). Replaces the old paid-probe interval claudeProbeMinutes. */
    claudePollMinutes: number;
  };
  /** Applied only with engine guardrails off. */
  tuning: EngineTuning;
  advanced: {
    nodeRuntime: "system" | "electron";
    debug: boolean;
    llamaCppLauncher: string;
    /**
     * On: the app validates each role's model against its own CLI and fixes loop limits.
     * Off: any model per role, checks
     * become warnings. For users who know the consequences.
     */
    engineGuardrails: boolean;
  };
  skills: {
    enabled: Record<string, boolean>;
    importedDirs: string[];
  };
  updates: {
    /** git: build from the source repository (developers). release: signed GitHub Releases, verified by the app. */
    channel?: "git" | "release";
    /** owner/name of the repository whose releases to install. */
    releaseRepo?: string;
    autoCheck: boolean;
    autoInstall: boolean;
    /** Minutes between background checks while the app runs (also on window focus); 0 = launch only. */
    checkMinutes: number;
    /** Git repository to update from: a local path now, a GitHub URL later. Empty = the source this build came from. */
    source: string;
    /** Empty = the branch this build came from. */
    branch: string;
  };
  onboardingComplete: boolean;
  activeProjectId: string | null;
}

export interface LimitWindow {
  id: string;
  label: string;
  usedPercent: number;
  resetsAt: string | null;
  windowMinutes: number | null;
}

/** Plan/rate-limit snapshot reported by a provider's own CLI. */
export interface ProviderLimits {
  provider: "codex" | "claude";
  ok: boolean;
  fetchedAt: string;
  source: string;
  plan: string | null;
  status: "ok" | "warning" | "limited" | "error";
  statusText: string;
  windows: LimitWindow[];
  extras: { label: string; value: string }[];
  error?: string;
}

export interface LimitsState {
  codex: ProviderLimits | null;
  claude: ProviderLimits | null;
  refreshing: { codex: boolean; claude: boolean };
}

/** One model as the orchestrator CLI itself advertises it. */
export interface CliModel {
  id: string;
  displayName: string;
  description: string;
  /** Resolved full model name when `id` is an alias (Claude: sonnet → claude-sonnet-5-5). */
  resolved: string | null;
  efforts: string[];
  defaultEffort: string | null;
  /** The model offers a Fast speed tier. */
  fast: boolean;
  fastDescription: string | null;
  isDefault: boolean;
}

export interface ProviderModels {
  provider: "codex" | "claude";
  ok: boolean;
  fetchedAt: string;
  source: string;
  models: CliModel[];
  /** Account-level fast availability, when the CLI reports it (Claude: fast_mode_disabled_reason). */
  fastBlockedReason: string | null;
  error: string | null;
}

export interface ModelCatalog {
  codex: ProviderModels | null;
  claude: ProviderModels | null;
  refreshing: { codex: boolean; claude: boolean };
}

export interface BuildInfo {
  commit: string;
  shortCommit: string;
  subject: string;
  committedAt: string;
  branch: string;
  source: string;
  builtAt: string;
}

export interface UpdateStatus {
  /** "portable": a portable copy with updates turned off (portable.json). */
  state: "dev" | "portable" | "idle" | "checking" | "up-to-date" | "available" | "building" | "ready" | "error";
  installed: BuildInfo | null;
  source: string;
  branch: string;
  latest: { commit: string; subject: string; version?: string | null } | null;
  /** body: the commit description (changelog), without trailers such as Co-Authored-By. */
  commits: { hash: string; subject: string; date: string; body: string }[];
  checkedAt: string | null;
  error: string | null;
  log: string[];
}

/** Normalised automation status for one project, derived from the engine's .state files. */
export type RunState = "running" | "pausing" | "paused" | "stopping" | "stopped" | "idle" | "attention" | "blocked" | "waiting-limit" | "complete";

export interface QaChecks {
  tests: string;
  typecheck: string;
  lint: string;
  build?: string;
  scopeCheck: string;
}

export interface EngineEvent {
  timestamp: string;
  type: string;
  taskId?: string;
  attempt?: number;
  qa?: string;
  message?: string;
  [key: string]: unknown;
}

export interface PlanTask {
  title: string;
  completed: boolean;
  depth: number;
}

/** A Supervisor-proposed IMPLEMENTATION_PLAN.md change (engine/src/plan-stewardship.mjs). */
/** One finished run (engine/src/run-budget.mjs writeRunReport). */
export interface RunReport {
  unattended: boolean;
  startedAt: string;
  endedAt: string;
  hours: number;
  status: string;
  reason: string | null;
  limit: string | null;
  tasksApproved: number;
  qaFailures: number;
  corrections: number;
  elevations: number;
  needsAttention: number;
  supervisorAlerts: number;
  approved?: { taskId: string | null; name: string | null; at: string }[];
  /** From 0.35: the configured task size, plan items checked off, and step-downs. Older reports: eco. */
  taskMode?: TaskMode;
  planItems?: number;
  stepDowns?: number;
  usage: { tokens: number; input: number; cached: number; output: number; costUsd: number; calls: number };
  actionLog: { ok: boolean; entries?: number; reason?: string };
}

/** Remote notification channels the engine sends to (engine/src/notify.mjs). */
export type NotifyChannel = "webhook" | "discord" | "slack" | "telegram" | "email";

export interface PlanProposal {
  id: string;
  at: string;
  source: string;
  reason: string;
  preview: string;
  status: "pending" | "approved" | "applied" | "dismissed" | "failed";
  /** Pending/approved only: whether it still fits today's plan, and why not. */
  applies?: boolean;
  problem?: string | null;
  commit?: string;
  decidedAt?: string;
}

export interface PlanPhase {
  number: number;
  title: string;
  tasks: PlanTask[];
  total: number;
  completed: number;
  percent: number | null;
}

export interface PlanProgress {
  source: string;
  phases: PlanPhase[];
  total: number;
  completed: number;
  percent: number | null;
  currentPhase: number | null;
  error?: string;
}

/** A plan item's key: hash of phase number, normalized title and duplicate ordinal (engine/src/task-priority.mjs). */
export type PlanItemKey = string;

/** <stateDir>/task-board.json: the Task board's priority order. Written by the app, read by the engine at each Assessment. */
export interface TaskBoardState {
  version: 1;
  revision: number;
  order: PlanItemKey[];
  groupByPhase: boolean;
  updatedAt: string | null;
}

export type TaskBoardColumn = "planned" | "in-progress" | "finished";

/** Who is working on an In progress item, or why a Planned one is set aside. */
export interface TaskBoardActivity {
  kind: "current" | "parallel" | "step-down" | "deferred";
  taskId: string;
  name: string;
  /** Parallel: the task engine's lane folder. Deferred: the reason. */
  detail?: string;
}

export interface TaskBoardItem {
  id: PlanItemKey;
  phase: { number: number; title: string };
  title: string;
  depth: number;
  column: TaskBoardColumn;
  /** Place in the priority order, from 0, for open items; null when finished. */
  priority: number | null;
  /** Its title appears on more than one plan line: the engine cannot check it off by text. */
  ambiguous: boolean;
  activity: TaskBoardActivity[];
}

export interface TaskBoard {
  revision: number;
  groupByPhase: boolean;
  /** Open items in priority order (In progress and Planned), then finished ones in plan order. */
  items: TaskBoardItem[];
}

export interface TaskBoardUpdate {
  /** The revision the change was made on; a different one on disk rejects it. */
  expectedRevision: number;
  /** The new priority order of open items. */
  order?: PlanItemKey[];
  /** Back to plan order. */
  reset?: boolean;
  groupByPhase?: boolean;
}

export type TaskBoardWriteResult = { ok: true; board: TaskBoard } | { ok: false; reason: "stale"; board: TaskBoard };

export interface GitInfo {
  isRepo: boolean;
  branch: string | null;
  head: string | null;
  remote: string | null;
  ahead: number | null;
  behind: number | null;
  changedFiles: { status: string; path: string }[];
  error?: string;
}

export interface ProjectStatus {
  projectId: string;
  runState: RunState;
  label: string;
  processAlive: boolean;
  pid: number | null;
  stage: string;
  cycle: "assessment" | "implementation" | "qa" | "correction" | "next" | null;
  task: { id: string; name: string; prompt: string; qaCommand?: string; allowedPaths?: string[] } | null;
  attempt: number;
  activeRole: string | null;
  activeModel: string | null;
  clineStatus: string;
  qaStatus: string;
  latestQa: string;
  qaChecks: QaChecks;
  clineStartedAt: string | null;
  clineElapsedMs: number | null;
  clineModel: string | null;
  clineProvider: string | null;
  contextTokens: number | null;
  control: { pauseAfterCurrent: boolean; stopAfterSafePoint: boolean };
  attentionReason: string | null;
  blockedReason: string | null;
  limitMessage: string | null;
  limitRetryAt: string | null;
  elevateAvailable: boolean;
  elevateReason: string | null;
  resolverAvailable: boolean;
  resolverReason: string | null;
  /** Blocked during Assessment, with no task underway: Retry runs Assessment again. */
  assessmentRetry: boolean;
  /** Blocked with a finished, in-scope attempt: Retry QA reviews it again. */
  qaRetry: boolean;
  /** The engine stopped in the middle of this step (crash, reboot, killed process), or null (interruptedWork). */
  interrupted: string | null;
  events: EngineEvent[];
  git: GitInfo;
  plan: PlanProgress;
  /** The Task board: plan items in Planned, In progress and Finished, in priority order. Absent from older builds. */
  board?: TaskBoard;
  /** The parallel round in progress (engine --parallel): each task with its live stage. Absent outside a round. */
  parallel?: ParallelRound;
  updatedAt: string | null;
}

/** Where one task of a parallel round is: its engine's stage while it works, then how it ended. */
export type ParallelTaskStage = "starting" | "assessment" | "implementation" | "qa" | "correction" | "waiting-limit" | "paused" | "working" | "approved" | "merged" | "failed" | "merge-failed" | "stopped";

export interface ParallelRoundTask {
  id: string;
  name: string;
  stage: ParallelTaskStage;
  attempt: number;
  branch: string | null;
  startedAt: string | null;
  /** Waiting out a usage limit. */
  waiting?: boolean;
}

/** A parallel round (engine parallel-round.json), with each task's live state from <state>/parallel/<task>/. */
export interface ParallelRound {
  round: number;
  startedAt: string | null;
  tasks: ParallelRoundTask[];
}

export interface TokenRecord {
  timestamp: string;
  role: "implementation" | "qa" | "assessment" | "elevation" | "resolver" | "custom";
  provider: string;
  model: string | null;
  input: number;
  cached: number;
  output: number;
  projectId: string;
  taskId: string | null;
  /** Local AI (Cline on llama.cpp / Ollama); otherwise a cloud CLI (Codex, Claude Code). */
  local?: boolean;
}

/** What occupies the Implementation agent's context window right now (local providers only). */
export interface LocalContext {
  state: "processing" | "idle" | "not-reported" | "unavailable" | "none";
  used: number | null;
  size: number | null;
  model: string | null;
  source: string;
}

export interface UsageSummary {
  records: TokenRecord[];
  compactions: number;
  sessionStartedAt: string | null;
  limit: { message: string | null; retryAt: string | null };
}

/** Where a custom workflow role runs in the loop. Roles are read-only. */
export type RoleStage = "before-implementation" | "before-qa" | "after-pass";

/** A user-defined workflow role (ROLE.md under <userData>/roles/<id>). Agents with role "custom" and customRole = id run it. */
export interface WorkflowRole {
  id: string;
  name: string;
  description: string;
  stage: RoleStage;
  /** Before QA only: a "changes-needed" verdict sends the change back for correction instead of to QA. */
  gate: boolean;
  /** Gates only: the role makes its own requested fix once per attempt (guarded, task files only) before a correction. */
  fix?: boolean;
  enabled: boolean;
  instructions: string;
  dir: string;
  warnings: string[];
}

/** Loop limits that are fixed with engine guardrails on. Defaults equal the engine's built-in values. */
export interface EngineTuning {
  elevationAfter: number;
  resolverMaxStrategies: number;
  /** 0 = no limit. */
  maxCorrections: number;
  taskMaxFiles: number;
  taskMaxNewLines: number;
  taskMaxReadFiles: number;
  /** Used for new Implementation agents; null = the engine default. */
  defaultContextTokens: number | null;
  defaultMaxOutputTokens: number | null;
}

export interface SkillFinding { level: "block" | "warn"; file: string; message: string }
export interface LibrarySkillPreview {
  name: string; description: string; path: string;
  files: { path: string; size: number }[]; skipped: { path: string; reason: string }[];
  findings: SkillFinding[];
}
/** A GitHub skill import, pinned to one commit and scanned, before anything is written. */
export interface LibraryPreview {
  token: string; owner: string; repo: string; commit: string; url: string; trusted: boolean;
  /** Large library listed by folder only; review the chosen folders before import. */
  browse: boolean;
  skills: LibrarySkillPreview[];
}

export interface SkillInfo {
  id: string;
  name: string;
  description: string;
  dir: string;
  source: "engine" | "imported";
  /** GitHub library imports: "owner/repo@commit7". */
  origin?: string;
  instructions: string;
  warnings: string[];
}

export interface EngineInfo {
  dir: string;
  orchestratorModels: { codex: Record<string, string>; claude: Record<string, string> };
  defaults: { contextTokens: number; maxOutputTokens: number; timeoutSeconds: number };
}

export interface AppSnapshot {
  projects: Project[];
  agents: Agent[];
  clis: CliConnection[];
  settings: Settings;
  engine: EngineInfo;
  roles: WorkflowRole[];
  /** docs: the guides bundled with the app (file name to absolute path), only those found on disk. */
  paths: { config: string; projectState: string; stopAll: string; docs?: Partial<Record<"user-guide.md" | "how-it-works.md", string>> };
  notifyChannels: Record<NotifyChannel, boolean>;
  /** Non-secret description of saved channels (Telegram chat, email inbox and recipients). */
  notifyDetails: Partial<Record<NotifyChannel, string>>;
  /** package.json version of the running app, e.g. 0.13.0 */
  version: string;
}

export type AddProjectRequest =
  | { mode: "local"; path: string; name: string; objective: string }
  | { mode: "github"; url: string; branch: string; parentDir: string; name: string; objective: string }
  | { mode: "new"; parentDir: string; name: string; initGit: boolean; starterPlan: boolean; objective: string };

export interface DirectoryInspection {
  path: string;
  exists: boolean;
  isRepo: boolean;
  branch: string | null;
  remote: string | null;
  planFile: string | null;
  planSummary: string | null;
  suggestedName: string;
}

export interface PathDetection {
  command: string;
  found: { path: string; version: string | null }[];
}
