import type { Settings } from "./types";

/**
 * Settings › Execution & safety › Safety level: one choice that sets the safety toggles together. Each toggle stays
 * adjustable on its own (the level then reads Custom). Applying one goes through the same checks as changing the
 * toggles by hand: weakening needs a native confirmation, and a sandbox turns on only after its setup and self-test.
 */
export type SafetyPresetName = "strict" | "standard" | "trusted";

export interface SafetyPreset {
  toolGuard: boolean;
  checksTrusted: boolean;
  askMinutes: number;
  approveTasks: boolean;
  sandboxChecks: boolean;
  sandboxAgents: boolean;
}

export const SAFETY_PRESETS: Record<SafetyPresetName, SafetyPreset & { label: string; summary: string }> = {
  strict: {
    label: "Strict", summary: "You approve every task; checks and agents' commands run in the sandbox; anything the guard cannot verify is refused.",
    toolGuard: true, checksTrusted: false, askMinutes: 0, approveTasks: true, sandboxChecks: true, sandboxAgents: true,
  },
  standard: {
    label: "Standard", summary: "Tasks run on their own; Agent Dock watches its own files during checks; anything the guard cannot verify is put to you for up to 10 minutes.",
    toolGuard: true, checksTrusted: false, askMinutes: 10, approveTasks: false, sandboxChecks: false, sandboxAgents: false,
  },
  trusted: {
    label: "Trusted", summary: "For projects whose tests you trust completely: checks run as you, unwatched; the guard still asks about what it cannot verify.",
    toolGuard: true, checksTrusted: true, askMinutes: 10, approveTasks: false, sandboxChecks: false, sandboxAgents: false,
  },
};

/** The current values of the toggles a preset sets. */
export function safetyValues(s: Settings): SafetyPreset {
  return {
    toolGuard: s.workflow.toolGuard !== false,
    checksTrusted: s.safety.checksTrusted === true,
    askMinutes: Math.max(0, Math.floor(Number(s.safety.askMinutes ?? 0)) || 0),
    approveTasks: s.workflow.approveTasks === true,
    sandboxChecks: s.safety.sandboxChecks === true,
    sandboxAgents: s.safety.sandboxAgents === true,
  };
}

/** Which preset the settings match exactly, or null (Custom). */
export function currentSafetyPreset(s: Settings): SafetyPresetName | null {
  const now = safetyValues(s);
  for (const [name, preset] of Object.entries(SAFETY_PRESETS) as [SafetyPresetName, SafetyPreset][]) {
    if ((Object.keys(now) as (keyof SafetyPreset)[]).every((k) => now[k] === preset[k])) return name;
  }
  return null;
}
