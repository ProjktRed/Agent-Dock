import type { Settings } from "@shared/types";
import { DEFAULT_SETTINGS } from "@shared/defaults";
import { normalizeAppearance } from "@shared/appearance";

type Plain = Record<string, unknown>;
const isPlain = (value: unknown): value is Plain => typeof value === "object" && value !== null && !Array.isArray(value);
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** A value may replace the reference only with the same shape (a known optional field takes any JSON value). */
function sameShape(reference: unknown, value: unknown): boolean {
  if (reference === undefined) return value !== undefined && typeof value !== "function";
  if (reference === null) return value === null || typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
  if (Array.isArray(reference)) return Array.isArray(value);
  if (typeof reference === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === typeof reference;
}

function merge(base: Plain, incoming: Plain, defaults: Plain): Plain {
  const out: Plain = { ...base };
  for (const [key, value] of Object.entries(incoming)) {
    if (UNSAFE_KEYS.has(key)) continue;
    const reference = key in base ? base[key] : defaults[key];
    if (isPlain(reference)) {
      if (isPlain(value)) out[key] = merge(reference, value, isPlain(defaults[key]) ? defaults[key] : {});
      continue;
    }
    if (sameShape(reference, value)) out[key] = value;
  }
  return out;
}

/**
 * Settings from the window, merged onto the current ones: a section or field of the wrong type keeps its
 * current value, so a malformed save can neither wipe the settings nor reach code that expects the shape.
 */
export function sanitizeSettings(incoming: unknown, current: Settings): Settings {
  const merged = merge(current as unknown as Plain, isPlain(incoming) ? incoming : {}, DEFAULT_SETTINGS as unknown as Plain) as unknown as Settings;
  merged.safety.protectedPaths = [...new Set(merged.safety.protectedPaths.filter((p): p is string => typeof p === "string" && p.trim() !== "").map((p) => p.trim()))];
  // Skill folders are added only through the main process's import (they also widen what Open folder may open); the window may remove them.
  merged.skills.importedDirs = merged.skills.importedDirs.filter((dir) => current.skills.importedDirs.includes(dir));
  // The sandbox for checks is turned on only after its setup and self-test pass (sandbox:set), and off only there.
  merged.safety.sandboxChecks = current.safety.sandboxChecks === true;
  merged.safety.sandboxAgents = current.safety.sandboxAgents === true;
  merged.safety.askMinutes = Math.min(60, Math.max(0, Math.floor(Number(merged.safety.askMinutes)) || 0));
  return { ...merged, general: { ...merged.general, ...normalizeAppearance(merged.general) } };
}

/** A change that weakens a safety control or chooses a program to run, and how to take it back. */
export interface Weakening {
  label: string;
  revert: (settings: Settings) => void;
}

export function weakenings(before: Settings, after: Settings): Weakening[] {
  const out: Weakening[] = [];
  if (before.workflow.toolGuard !== false && after.workflow.toolGuard === false) out.push({ label: "Turn the worker tool guard off", revert: (s) => { s.workflow = { ...s.workflow, toolGuard: true }; } });
  if (before.safety.checksTrusted !== true && after.safety.checksTrusted === true) out.push({ label: "Trust project check scripts (stop watching Agent Dock's own files during runs)", revert: (s) => { s.safety = { ...s.safety, checksTrusted: false }; } });
  if (before.safety.webAccess !== true && after.safety.webAccess === true) out.push({ label: "Let agents search the web and read web pages", revert: (s) => { s.safety = { ...s.safety, webAccess: false }; } });
  if (before.advanced.engineGuardrails !== false && after.advanced.engineGuardrails === false) out.push({ label: "Turn the engine guardrails off", revert: (s) => { s.advanced = { ...s.advanced, engineGuardrails: true }; } });
  const removed = before.safety.protectedPaths.filter((p) => !after.safety.protectedPaths.includes(p));
  if (removed.length) out.push({ label: `Stop protecting ${removed.join(", ")}`, revert: (s) => { s.safety = { ...s.safety, protectedPaths: [...new Set([...s.safety.protectedPaths, ...removed])] }; } });
  if (before.general.remoteApprovals !== true && after.general.remoteApprovals === true) out.push({ label: "Accept approvals from Telegram and email", revert: (s) => { s.general = { ...s.general, remoteApprovals: false }; } });
  for (const key of ["llamaCppLauncher", "nodeRuntime"] as const) {
    if (before.advanced[key] !== after.advanced[key]) out.push({ label: key === "nodeRuntime" ? `Run the engine with the ${after.advanced.nodeRuntime === "system" ? "system" : "bundled"} Node runtime` : `Start llama.cpp with ${after.advanced.llamaCppLauncher || "the default launcher"}`, revert: (s) => { s.advanced = { ...s.advanced, [key]: before.advanced[key] }; } });
  }
  for (const key of ["source", "branch", "channel", "releaseRepo"] as const) {
    if ((before.updates[key] ?? "") !== (after.updates[key] ?? "")) out.push({ label: `Install updates from ${key === "branch" ? "branch" : key === "channel" ? "the channel" : ""} ${after.updates[key] || "the default"}`.replace(/\s+/g, " "), revert: (s) => { s.updates = { ...s.updates, [key]: before.updates[key] }; } });
  }
  return out;
}
