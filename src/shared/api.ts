import type {
  AddProjectRequest,
  Agent,
  AppSnapshot,
  CliConnection,
  CliHealth,
  DirectoryInspection,
  LimitsState,
  ModelCatalog,
  PathDetection,
  Project,
  ProjectStatus,
  Settings,
  SkillInfo,
  LibraryPreview,
  UpdateStatus,
  UsageSummary,
  LocalContext,
  NotifyChannel,
  PlanProposal,
  RunReport,
  WorkflowRole,
} from "./types";

export type ControlAction = "start" | "pause" | "resume" | "stop" | "stop-now" | "stop-after-task" | "elevate" | "resolve" | "retry-qa";

export interface LaunchCheck {
  problems: string[];
  /** Engine guardrails off: what the guardrails would have blocked. The start goes ahead. */
  warnings: string[];
  summary: { implementation: string; orchestrator: string };
  args: string[];
  /** Workflow roles the engine will run (written to <state>/workflow-roles.json at start). */
  roles: EngineRoleEntry[];
  /** Skill names assigned per engine role (written with their instructions to <state>/assigned-skills.json at start). */
  skills: Record<string, string[]>;
  /** Implementation skills Assessment may pick per task (written to the same file with their descriptions). */
  autoSkills: string[];
  /** Assessment may pick from every imported, enabled skill (the Implementer's toggle). */
  autoAllImported: boolean;
  /** Each role agent's custom instructions (written to the same file). */
  notes: Record<string, string>;
}

/** One entry of the engine's --roles-file. */
export interface EngineRoleEntry {
  id: string;
  name: string;
  stage: WorkflowRole["stage"];
  gate: boolean;
  cli: "codex" | "claude";
  model?: string;
  effort?: string;
  fast: boolean;
  instructions: string;
}

export type RoleDraft = Omit<WorkflowRole, "dir" | "warnings" | "id"> & { id?: string };

export interface HistoryEntry {
  taskId: string;
  outcome: "approved" | "failed" | "attention" | "blocked" | "stopped";
  attempts: number;
  finishedAt: string;
  summary: string;
}

export interface Notice {
  kind: "success" | "warning" | "error" | "info";
  message: string;
}

/** The surface exposed to the renderer as `window.api` (src/preload/index.ts). */
export interface DesktopApi {
  snapshot(): Promise<AppSnapshot>;
  saveSettings(settings: Settings): Promise<Settings>;
  saveAgent(agent: Agent): Promise<Agent[]>;
  deleteAgent(id: string): Promise<Agent[]>;
  saveCli(cli: CliConnection, secret?: string | null): Promise<CliConnection[]>;
  deleteCli(id: string): Promise<CliConnection[]>;
  checkCli(id: string): Promise<CliHealth>;
  healths(): Promise<CliHealth[]>;
  detectOnPath(command: string): Promise<PathDetection>;
  testConnection(cli: CliConnection, secret?: string | null): Promise<CliHealth>;
  /** Local providers: ask the provider for its models and store the list on the connection. */
  collectModels(id: string): Promise<CliConnection[]>;
  /** The models folder the llama.cpp launcher's settings point into, if found. */
  detectModelsDir(): Promise<string | null>;
  pickDirectory(title: string): Promise<string | null>;
  pickTaskFile(): Promise<string | null>;
  inspectDirectory(dir: string): Promise<DirectoryInspection>;
  addProject(request: AddProjectRequest): Promise<Project>;
  /** Writes nothing: returns the generated IMPLEMENTATION_PLAN.md text for review. */
  generatePlan(projectId: string, cliId: string, model: string | null): Promise<string>;
  cancelPlan(projectId: string): Promise<void>;
  /** Writes the reviewed plan (never over an existing one) and commits only that file in a Git repo. */
  savePlan(projectId: string, text: string): Promise<{ committed: boolean }>;
  updateProject(project: Project): Promise<Project[]>;
  removeProject(id: string, deleteHistory: boolean): Promise<Project[]>;
  setActiveProject(id: string | null): Promise<void>;
  status(projectId: string): Promise<ProjectStatus>;
  launchCheck(projectId: string): Promise<LaunchCheck>;
  control(projectId: string, action: ControlAction): Promise<void>;
  /** Stops every running project: at its next safe point, or at once with now. */
  stopAll(now: boolean): Promise<{ project: string; result: string }[]>;
  /** Saves (encrypted) or clears a remote notification channel URL; returns the new snapshot. */
  setNotifyChannel(kind: NotifyChannel, value: string | Record<string, string> | null): Promise<AppSnapshot>;
  testNotifyChannel(kind: NotifyChannel): Promise<void>;
  /** Checks each project's hash-chained action log. */
  /** Sets the stopped project's current task aside: its work goes into a named git stash, the next Run starts a fresh Assessment. */
  setAside(projectId: string): Promise<{ id: string; stash: { message: string } | null }>;
  /** Saves a diagnostics zip (secrets removed) where the user picks; null when cancelled. */
  exportDiagnostics(): Promise<string | null>;
  /** Finished runs of a project, newest first. */
  runs(projectId: string): Promise<RunReport[]>;
  /** Supervisor plan proposals for a project, newest last. */
  planProposals(projectId: string): Promise<PlanProposal[]>;
  /** Approve (committed between tasks, or now when the engine is idle) or dismiss a plan proposal. */
  decidePlanProposal(projectId: string, id: string, decision: "approve" | "dismiss"): Promise<PlanProposal[]>;
  verifyActionLogs(): Promise<{ project: string; ok: boolean; entries: number; lastAt: string | null; brokenAt?: number; reason?: string }[]>;
  usage(projectId: string | null): Promise<UsageSummary>;
  /** Live context occupancy of the project's local Implementation agent (llama.cpp /slots). */
  localContext(projectId: string): Promise<LocalContext>;
  history(projectId: string): Promise<HistoryEntry[]>;
  /** Windows: the project's shared .git folder owned by another account, with the Administrator fix. */
  gitOwner(projectId: string): Promise<{ dir: string; owner: string; user: string; command: string } | null>;
  engineLog(projectId: string): Promise<string>;
  skills(): Promise<SkillInfo[]>;
  importSkillFolder(): Promise<SkillInfo[]>;
  skillLibraries(): Promise<{ label: string; url: string }[]>;
  previewSkillImport(url: string, only?: string[]): Promise<LibraryPreview>;
  installSkillImport(token: string, names: string[]): Promise<SkillInfo[]>;
  roles(): Promise<WorkflowRole[]>;
  saveRole(role: RoleDraft): Promise<WorkflowRole[]>;
  deleteRole(id: string): Promise<WorkflowRole[]>;
  importRoleFolder(): Promise<{ roles: WorkflowRole[]; imported: number }>;
  openPath(target: string): Promise<void>;
  limits(): Promise<LimitsState>;
  refreshLimits(provider: "codex" | "claude"): Promise<LimitsState>;
  onLimits(callback: (state: LimitsState) => void): () => void;
  models(): Promise<ModelCatalog>;
  refreshModels(provider: "codex" | "claude"): Promise<ModelCatalog>;
  onModels(callback: (state: ModelCatalog) => void): () => void;
  updateStatus(): Promise<UpdateStatus>;
  checkForUpdates(): Promise<UpdateStatus>;
  applyUpdate(): Promise<void>;
  onUpdate(callback: (status: UpdateStatus) => void): () => void;
  windowControl(action: "minimize" | "maximize" | "close"): Promise<void>;
  onStatus(callback: (status: ProjectStatus) => void): () => void;
  onHealth(callback: (health: CliHealth) => void): () => void;
  onNotice(callback: (notice: Notice) => void): () => void;
}
