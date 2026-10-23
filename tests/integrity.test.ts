import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { engineFileProblems, hashFiles, manifestProblems } from "../src/main/lib/integrity";
import { readJson, rememberContent, restoreWatchedFiles, watchFolder, writeJson } from "../src/main/lib/json-file";
import { mergeImport } from "../src/main/settings-transfer";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";

const temp = () => mkdtempSync(join(tmpdir(), "dock-integrity-"));

describe("engine file list (S-02)", () => {
  it("finds changed, missing and added engine files", () => {
    const root = temp();
    try {
      mkdirSync(join(root, "engine", "src", "guard"), { recursive: true });
      mkdirSync(join(root, "scripts"));
      writeFileSync(join(root, "engine", "src", "cli.mjs"), "a");
      writeFileSync(join(root, "engine", "src", "guard", "decide.mjs"), "b");
      writeFileSync(join(root, "scripts", "swap.mjs"), "c");
      const manifest = hashFiles(root);
      expect(Object.keys(manifest)).toEqual(["engine/src/cli.mjs", "engine/src/guard/decide.mjs", "scripts/swap.mjs"]);
      writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest));
      expect(engineFileProblems(root, join(root, "manifest.json"))).toEqual([]);
      writeFileSync(join(root, "engine", "src", "guard", "decide.mjs"), "allow everything");
      rmSync(join(root, "scripts", "swap.mjs"));
      writeFileSync(join(root, "engine", "src", "extra.mjs"), "x");
      expect(manifestProblems(manifest, hashFiles(root))).toEqual(["engine/src/guard/decide.mjs was changed", "scripts/swap.mjs is missing", "engine/src/extra.mjs was added"]);
      expect(engineFileProblems(root, join(root, "no-such-file.json"))).toEqual(["the engine file list is missing from this build"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("config folder watch (S-02)", () => {
  it("puts back what something else wrote, keeps the changed copy, and leaves the app's own writes alone", async () => {
    const root = temp();
    try {
      const config = join(root, "config");
      watchFolder(config);
      await writeJson(join(config, "settings.json"), { workflow: { toolGuard: true } });
      writeFileSync(join(config, "clis.json"), "[]\n");
      await readJson(join(config, "clis.json"), []);
      await readJson(join(config, "agents.json"), null);
      rememberContent(join(config, "stop-all.cmd"), "@echo off\r\n");
      writeFileSync(join(config, "stop-all.cmd"), "@echo off\r\n");
      expect(await restoreWatchedFiles()).toEqual([]);

      await writeJson(join(config, "settings.json"), { workflow: { toolGuard: true }, general: { theme: "dark" } });
      expect(await restoreWatchedFiles()).toEqual([]);

      writeFileSync(join(config, "settings.json"), JSON.stringify({ workflow: { toolGuard: false } }));
      writeFileSync(join(config, "agents.json"), "[]");
      writeFileSync(join(config, "stop-all.cmd"), "calc.exe\r\n");
      const restored = await restoreWatchedFiles();
      expect(restored.map((f) => f.slice(config.length + 1))).toEqual(["agents.json", "settings.json", "stop-all.cmd"]);
      expect(JSON.parse(readFileSync(join(config, "settings.json"), "utf8"))).toEqual({ workflow: { toolGuard: true }, general: { theme: "dark" } });
      expect(existsSync(join(config, "agents.json"))).toBe(false);
      expect(readFileSync(join(config, "stop-all.cmd"), "utf8")).toBe("@echo off\r\n");
      const kept = readdirSync(config).filter((f) => f.includes(".changed-"));
      expect(kept.length).toBe(3);
      if (process.platform !== "win32") expect(statSync(join(config, "settings.json")).mode & 0o777).toBe(0o600);
      expect(await restoreWatchedFiles()).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("settings import", () => {
  it("never turns on trust in project checks", () => {
    const local = structuredClone(DEFAULT_SETTINGS);
    const result = mergeImport({ settings: local, agents: [], clis: [] }, { format: "agent-dock-settings", version: 1, exportedAt: "", appVersion: "", settings: { ...local, safety: { ...local.safety, checksTrusted: true } }, agents: [], clis: [], roles: [] } as never);
    expect(result.settings.safety.checksTrusted).toBe(false);
    expect(result.summary.skipped).toContain("Project checks trusted");
  });
});
