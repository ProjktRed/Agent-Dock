import type { Agent, CliConnection, Settings } from "@shared/types";

// Mirrors engine/src/loop-options.mjs defaults. Local models have none: each agent names its own.
export const ENGINE_DEFAULTS = {
  contextTokens: 98_304,
  maxOutputTokens: 8_192,
  timeoutSeconds: 1_800,
};

const cli = (id: string, kind: CliConnection["kind"], name: string, location: string): CliConnection => ({
  id,
  kind,
  name,
  location,
  builtIn: true,
  startupTimeoutSeconds: 15,
  requestTimeoutSeconds: kind === "ollama" || kind === "llamacpp" || kind === "openai" ? 8 : 20,
  contextCap: null,
  defaultModel: null,
  manualModels: [],
  env: [],
  hasSecret: false,
});

/**
 * Every connection Agent Dock knows how to use. A fresh install adds only the ones found on this
 * computer (main/discovery.ts); the rest can be added in CLIs.
 */
export const DEFAULT_CLIS: CliConnection[] = [
  cli("codex", "codex", "Codex CLI", "codex"),
  cli("cline", "cline", "Cline CLI", "cline"),
  cli("claude", "claude", "Claude Code", "claude"),
  cli("opencode", "opencode", "OpenCode", "opencode"),
  cli("llamacpp", "llamacpp", "llama.cpp server", "http://127.0.0.1:8080/v1"),
  cli("ollama", "ollama", "Ollama", "http://127.0.0.1:11434"),
];

/** Repository the signed releases are published to (the source repository itself). */
export const DEFAULT_RELEASE_REPO = "ProjktRed/Agent-Dock";
/** The source repository was briefly named Agent-Dock-Dev; settings and builds from then still record that address. */
export const FORMER_SOURCE = /^https:\/\/github\.com\/ProjktRed\/Agent-Dock-Dev(?:\.git)?\/?$/i;
export const SOURCE_URL = "https://github.com/ProjktRed/Agent-Dock.git";

/** Builds made by the release workflow (build-info branch "release") have no source to build from: they always use signed releases. */
export const updateChannel = (settings: { updates: { channel?: "git" | "release" } }, installedBranch?: string | null): "git" | "release" =>
  installedBranch === "release" ? "release" : settings.updates.channel ?? "git";

/** What first-run discovery found: the planning/QA CLI, and a local model runtime for Cline if there is one. */
export interface FoundTools {
  orchestrator: "codex" | "claude" | null;
  local: "llamacpp" | "ollama" | null;
}

/**
 * The first agents, built from what is installed. Planning and QA use the orchestrator CLI on its default
 * models; Implementation uses Cline on a local runtime when both exist, otherwise the orchestrator CLI.
 * Nothing found leaves the CLI empty, for setup to fill in.
 */
export function defaultAgents(models: { qa: string; assessment: string; elevate: string; reasoning: string }, found: FoundTools = { orchestrator: "codex", local: "llamacpp" }): Agent[] {
  const base = { maxOutputTokens: ENGINE_DEFAULTS.maxOutputTokens, timeoutSeconds: ENGINE_DEFAULTS.timeoutSeconds, skills: ["bounded-task-handoff"], enabled: true };
  const orch = found.orchestrator ?? "";
  const impl: Agent = found.local
    ? { ...base, id: "implementer", name: "Implementer", role: "implementation", cliId: "cline", provider: found.local, model: "", contextTokens: ENGINE_DEFAULTS.contextTokens, instructions: "" }
    : { ...base, id: "implementer", name: "Implementer", role: "implementation", cliId: orch, model: "", contextTokens: 0, instructions: "" };
  return [
    impl,
    { ...base, id: "reviewer", name: "Reviewer", role: "qa", cliId: orch, model: models.qa, reasoning: models.reasoning, contextTokens: 0, instructions: "" },
    { ...base, id: "assessor", name: "Assessor", role: "assessment", cliId: orch, model: models.assessment, reasoning: models.reasoning, contextTokens: 0, instructions: "" },
    { ...base, id: "elevation", name: "Elevation", role: "elevation", cliId: orch, model: models.elevate, reasoning: models.reasoning, contextTokens: 0, instructions: "" },
  ];
}

export const DEFAULT_SETTINGS: Settings = {
  general: {
    launchAtStartup: false,
    startMinimized: false,
    keepInTray: true,
    theme: "dark",
    accent: "#82A9E8",
    notifyCompleted: true,
    notifyErrors: true,
    notifyInfo: false,
    notifyDigests: true,
    remoteApprovals: false,
    retentionDays: 30,
    defaultProject: "last",
  },
  workflow: {
    autoContinue: true,
    automaticElevation: true,
    toolGuard: true,
    resumeAfterRestart: "ask",
    stopAfterCurrentTask: false,
    unattended: false,
    taskMode: "eco",
    stepDown: true,
    parallelTasks: 1,
    maxLimits: { files: 0, newLines: 0, readFiles: 0, timeoutMinutes: 0 },
    unattendedLimits: { maxTasks: 10, maxHours: 8, maxCorrections: 6, maxElevations: 3, maxMillionTokens: 0, maxCostUsd: 0, maxMillionTokensDay: 0, maxCostUsdDay: 0 },
    supervisor: { mode: "alert", stallMinutes: 30, repeatFailures: 3, refusals: 5, millionTokensPerTask: 0, planDrift: 3, scopePaths: 25, digestHours: 0, review: "off", reviewer: "auto", reviewerModel: "", reviewerBaseUrl: "http://127.0.0.1:8080/v1", mayDefer: false, reviewMax: 6, planProposals: true },
  },
  attention: { informational: "in-app", recommendPause: "windows", mandatory: "windows", blocker: "windows" },
  context: { warnThresholdPercent: 80 },
  safety: { protectedPaths: [".git/", ".env*", "secrets/"] },
  usage: { manualBudgets: [], codexPollMinutes: 5, claudePollMinutes: 5 },
  advanced: { nodeRuntime: "system", debug: false, llamaCppLauncher: "", engineGuardrails: true },
  skills: { enabled: {}, importedDirs: [] },
  tuning: { elevationAfter: 3, resolverMaxStrategies: 3, maxCorrections: 0, taskMaxFiles: 1, taskMaxNewLines: 200, taskMaxReadFiles: 3, defaultContextTokens: null, defaultMaxOutputTokens: null },
  updates: { autoCheck: true, autoInstall: false, checkMinutes: 30, source: "", branch: "", channel: "git", releaseRepo: DEFAULT_RELEASE_REPO },
  onboardingComplete: false,
  activeProjectId: null,
};
