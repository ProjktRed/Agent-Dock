import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import { sanitizeSettings, weakenings } from "../src/main/settings-validate";
import { mergeImport, parseSettingsFile } from "../src/main/settings-transfer";
import { addProject, folderNameProblem, managedProjectFolder } from "../src/main/projects";
import { canOpenPath } from "../src/main/lib/safe-open";
import { resolveAppPath } from "../src/main/lib/app-protocol";
import type { AddProjectRequest } from "../src/shared/types";

const temp = () => mkdtempSync(path.join(tmpdir(), "dock-input-"));

describe("settings:save (S-07)", () => {
  it("keeps the current value for a malformed section or field instead of wiping the settings", () => {
    const current = structuredClone(DEFAULT_SETTINGS);
    for (const incoming of [null, "x", 42, [], { workflow: null }, { workflow: "off" }, { general: { theme: 5 } }, { safety: { protectedPaths: "none" } }, { usage: { codexPollMinutes: "5" } }]) {
      const saved = sanitizeSettings(incoming, current);
      expect(saved.workflow.toolGuard).toBe(true);
      expect(saved.general.theme).toBe(current.general.theme);
      expect(saved.safety.protectedPaths).toEqual(current.safety.protectedPaths);
      expect(saved.usage.codexPollMinutes).toBe(current.usage.codexPollMinutes);
    }
    const saved = sanitizeSettings({ ...current, general: { ...current.general, notifyInfo: false }, workflow: { ...current.workflow, unattendedLimits: { ...current.workflow.unattendedLimits, maxTasks: 3 } } }, current);
    expect(saved.general.notifyInfo).toBe(false);
    expect(saved.workflow.unattendedLimits.maxTasks).toBe(3);
    expect(Object.prototype.hasOwnProperty.call(sanitizeSettings(JSON.parse('{"__proto__":{"polluted":true}}'), current), "polluted")).toBe(false);
  });

  it("names every change that weakens a safety control or picks a program, and can take each back", () => {
    const before = structuredClone(DEFAULT_SETTINGS);
    const after = sanitizeSettings({
      workflow: { toolGuard: false }, safety: { protectedPaths: [".git/"], checksTrusted: true }, advanced: { engineGuardrails: false, llamaCppLauncher: "C:\\x\\llama.exe", nodeRuntime: "electron" },
      updates: { source: "https://example.invalid/fork.git" }, general: { remoteApprovals: true },
    }, before);
    const found = weakenings(before, after);
    expect(found.map((w) => w.label).join(" | ")).toMatch(/tool guard.*project check.*guardrails.*Stop protecting \.env\*.*approvals.*llama\.cpp.*bundled Node.*updates from https:\/\/example\.invalid/);
    for (const w of found) w.revert(after);
    expect(weakenings(before, after)).toEqual([]);
    expect(after.safety.protectedPaths).toEqual(expect.arrayContaining(before.safety.protectedPaths));
    expect(weakenings(before, sanitizeSettings({ general: { theme: "darker" }, safety: { protectedPaths: [...before.safety.protectedPaths, "migrations/"] } }, before))).toEqual([]);
  });
});

describe("settings import (R-17)", () => {
  const file = (settings: unknown, clis: unknown[] = []) => JSON.stringify({ format: "agent-dock-settings", version: 1, exportedAt: "", appVersion: "", settings, agents: [], clis, roles: [] });
  it("refuses connections with malformed environment entries", () => {
    for (const env of [[null], ["PATH"], [{ key: 1, value: "", secret: false }], [{ key: "A", value: null, secret: false }]]) {
      expect(() => parseSettingsFile(file({}, [{ id: "c", kind: "codex", env }]))).toThrow(/invalid connection/);
    }
  });
  it("applies a file with null or mistyped sections without throwing, keeping this computer's values", () => {
    const local = structuredClone(DEFAULT_SETTINGS);
    const parsed = parseSettingsFile(file({ workflow: null, context: { warnThresholdPercent: "80" }, general: { theme: "darker" } }));
    const result = mergeImport({ settings: local, agents: [], clis: [] }, parsed);
    expect(result.settings.workflow).toEqual(local.workflow);
    expect(result.settings.context.warnThresholdPercent).toBe(80);
    expect(result.settings.general.theme).toBe("darker");
  });
});

describe("project folders (S-10, R-15, S-22)", () => {
  const request = (parentDir: string, name: string, mode: "new" | "local" = "new", dir = "") => ({ mode, name, parentDir, path: dir, objective: "", initGit: false, starterPlan: false, url: "", branch: "" }) as unknown as AddProjectRequest;

  it("refuses a project name that would leave the chosen folder or that Windows refuses", async () => {
    const root = temp();
    try {
      for (const name of ["../escaped", "..", "a/b", "a\\b", "x:y", "CON", "name."]) {
        expect(folderNameProblem(name)).not.toBeNull();
        await expect(addProject(request(root, name), [], path.join(root, "state"))).rejects.toThrow();
      }
      expect(folderNameProblem("trailing ")).not.toBeNull();
      expect(folderNameProblem("My project 2")).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("registers only folders, never a regular file", async () => {
    const root = temp();
    try {
      writeFileSync(path.join(root, "file.txt"), "x");
      await expect(addProject(request(root, "F", "local", path.join(root, "file.txt")), [], path.join(root, "state"))).rejects.toThrow(/not a folder/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("checks containment by real location: a junction inside an allowed folder does not count as inside", () => {
    const root = temp();
    try {
      const allowed = path.join(root, "allowed"), outside = path.join(root, "outside");
      mkdirSync(allowed); mkdirSync(outside); mkdirSync(path.join(root, "renderer"));
      writeFileSync(path.join(outside, "notes.md"), "x");
      symlinkSync(outside, path.join(allowed, "link"), "junction");
      symlinkSync(outside, path.join(root, "renderer", "assets"), "junction");
      expect(canOpenPath(path.join(allowed, "link", "notes.md"), [allowed], false)).toBe(false);
      expect(canOpenPath(path.join(allowed, "link"), [allowed], true)).toBe(false);
      expect(canOpenPath(allowed, [allowed], true)).toBe(true);
      expect(resolveAppPath(path.join(root, "renderer"), "app://agent-dock/assets/notes.md")).toBeNull();
      const stateRoot = path.join(root, "projects");
      mkdirSync(stateRoot);
      symlinkSync(outside, path.join(stateRoot, "p1"), "junction");
      expect(managedProjectFolder(stateRoot, path.join(stateRoot, "p1", "state"))).toBeNull();
      mkdirSync(path.join(stateRoot, "p2"));
      expect(managedProjectFolder(stateRoot, path.join(stateRoot, "p2", "state"))).toBe(path.join(stateRoot, "p2"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
