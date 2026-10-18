import type { Agent, CliConnection, Settings } from "@shared/types";

// Mirrors engine/src/loop-options.mjs defaults so a fresh install runs the same configuration.
export const ENGINE_DEFAULTS = {
  llamacppModel: "glm-4.7-flash-ud-q3-k-xl",
  ollamaModel: "glm-4.7-flash:q4_K_M",
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

export const DEFAULT_CLIS: CliConnection[] = [
  cli("codex", "codex", "Codex CLI", "codex"),
  cli("cline", "cline", "Cline CLI", "cline"),
  cli("claude", "claude", "Claude Code", "claude"),
  cli("opencode", "opencode", "OpenCode", "opencode"),
  cli("llamacpp", "llamacpp", "llama.cpp server", "http://127.0.0.1:8081/v1"),
  cli("ollama", "ollama", "Ollama", "http://127.0.0.1:11434"),
];

export function defaultAgents(models: { qa: string; assessment: string; elevate: string; reasoning: string }): Agent[] {
  const base = { maxOutputTokens: ENGINE_DEFAULTS.maxOutputTokens, timeoutSeconds: ENGINE_DEFAULTS.timeoutSeconds, skills: ["bounded-task-handoff"], enabled: true };
  return [
    {
      ...base,
      id: "implementer",
      name: "Implementer",
      role: "implementation",
      cliId: "cline",
      provider: "llamacpp",
      model: ENGINE_DEFAULTS.llamacppModel,
      contextTokens: ENGINE_DEFAULTS.contextTokens,
      instructions: "",
    },
    { ...base, id: "reviewer", name: "Reviewer", role: "qa", cliId: "codex", model: models.qa, reasoning: models.reasoning, contextTokens: 0, instructions: "" },
    { ...base, id: "assessor", name: "Assessor", role: "assessment", cliId: "codex", model: models.assessment, reasoning: models.reasoning, contextTokens: 0, instructions: "" },
    { ...base, id: "elevation", name: "Elevation", role: "elevation", cliId: "codex", model: models.elevate, reasoning: models.reasoning, contextTokens: 0, instructions: "" },
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
    defaultProject: "last",
  },
  workflow: {
    autoContinue: true,
    automaticElevation: true,
    toolGuard: true,
    resumeAfterRestart: "ask",
    stopAfterCurrentTask: false,
    unattended: false,
    unattendedLimits: { maxTasks: 10, maxHours: 8, maxCorrections: 6, maxElevations: 3, maxMillionTokens: 0, maxCostUsd: 0, maxMillionTokensDay: 0, maxCostUsdDay: 0 },
  },
  attention: { informational: "in-app", recommendPause: "windows", mandatory: "windows", blocker: "windows" },
  context: { warnThresholdPercent: 80 },
  safety: { protectedPaths: [".git/", ".env*", "secrets/"] },
  usage: { manualBudgets: [], codexPollMinutes: 5, claudePollMinutes: 5 },
  advanced: { nodeRuntime: "system", debug: false, llamaCppLauncher: "", engineGuardrails: true },
  skills: { enabled: {}, importedDirs: [] },
  tuning: { elevationAfter: 3, resolverMaxStrategies: 3, maxCorrections: 0, taskMaxFiles: 1, taskMaxNewLines: 200, taskMaxReadFiles: 3, defaultContextTokens: null, defaultMaxOutputTokens: null },
  updates: { autoCheck: true, autoInstall: false, checkMinutes: 30, source: "", branch: "" },
  onboardingComplete: false,
  activeProjectId: null,
};
