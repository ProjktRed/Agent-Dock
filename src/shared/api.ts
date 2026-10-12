import type {
  AddProjectRequest,
  Agent,
  AppSnapshot,
  CliConnection,
  CliHealth,
  DirectoryInspection,
  LimitsState,
  PathDetection,
  Project,
  ProjectStatus,
  Settings,
  SkillInfo,
  UpdateStatus,
  UsageSummary,
} from "./types";

export type ControlAction = "start" | "pause" | "resume" | "stop" | "stop-now" | "stop-after-task" | "elevate" | "resolve";

export interface LaunchCheck {
  problems: string[];
  summary: { implementation: string; orchestrator: string };
  args: string[];
}

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
  pickDirectory(title: string): Promise<string | null>;
  pickTaskFile(): Promise<string | null>;
  inspectDirectory(dir: string): Promise<DirectoryInspection>;
  addProject(request: AddProjectRequest): Promise<Project>;
  updateProject(project: Project): Promise<Project[]>;
  removeProject(id: string, deleteHistory: boolean): Promise<Project[]>;
  setActiveProject(id: string | null): Promise<void>;
  status(projectId: string): Promise<ProjectStatus>;
  launchCheck(projectId: string): Promise<LaunchCheck>;
  control(projectId: string, action: ControlAction): Promise<void>;
  usage(projectId: string | null): Promise<UsageSummary>;
  history(projectId: string): Promise<HistoryEntry[]>;
  engineLog(projectId: string): Promise<string>;
  skills(): Promise<SkillInfo[]>;
  importSkillFolder(): Promise<SkillInfo[]>;
  openPath(target: string): Promise<void>;
  limits(): Promise<LimitsState>;
  refreshLimits(provider: "codex" | "claude"): Promise<LimitsState>;
  onLimits(callback: (state: LimitsState) => void): () => void;
  updateStatus(): Promise<UpdateStatus>;
  checkForUpdates(): Promise<UpdateStatus>;
  applyUpdate(): Promise<void>;
  onUpdate(callback: (status: UpdateStatus) => void): () => void;
  windowControl(action: "minimize" | "maximize" | "close"): Promise<void>;
  onStatus(callback: (status: ProjectStatus) => void): () => void;
  onHealth(callback: (health: CliHealth) => void): () => void;
  onNotice(callback: (notice: Notice) => void): () => void;
}
