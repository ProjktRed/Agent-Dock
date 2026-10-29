import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildStatus, CHANGED_FILES_SHOWN, STATUS_TEXT_LIMIT } from "../src/main/lib/status";
import { gitInfo } from "../src/main/lib/git";
import { EngineManager } from "../src/main/engine";
import { parseImplementationPlan } from "../src/main/lib/plan";
import type { GitInfo, Project } from "../src/shared/types";

// A blocked scope check once listed an untracked node_modules in one 960 KB message, which the app
// re-read and redrew on every poll until the window froze.
const huge = "node_modules/x.js, ".repeat(50_000);
const git: GitInfo = { isRepo: true, branch: "main", head: "abc", remote: null, ahead: 0, behind: 0, changedFiles: [] };
const base = { projectId: "p", control: {}, processAlive: false, pid: null, git, plan: parseImplementationPlan(""), elevate: { available: false, reason: null }, resolver: { available: false, reason: null } };

describe("status stays small whatever the engine wrote", () => {
  it("clips the QA text, the blocked reason and every event text", () => {
    const s = buildStatus({ ...base, live: { stage: "BLOCKED", latestQa: huge, blockedReason: huge, task: { id: "t", prompt: huge } }, events: [{ type: "blocked", timestamp: "t", qa: huge } as never] });
    expect(s.latestQa.length).toBeLessThanOrEqual(STATUS_TEXT_LIMIT);
    expect(s.blockedReason!.length).toBeLessThanOrEqual(STATUS_TEXT_LIMIT);
    expect(String((s.events[0] as { qa?: string }).qa).length).toBeLessThanOrEqual(STATUS_TEXT_LIMIT);
    expect(s.task!.prompt.length).toBeLessThanOrEqual(STATUS_TEXT_LIMIT);
    expect(s.latestQa).toMatch(/characters left out/);
    expect(JSON.stringify(s).length).toBeLessThan(100_000);
  });
});

describe("changed files", () => {
  it("sends the first files and counts them all", async () => {
    const root = mkdtempSync(join(tmpdir(), "dock-changed-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: root });
      mkdirSync(join(root, "node_modules"));
      for (let i = 0; i < CHANGED_FILES_SHOWN + 200; i++) writeFileSync(join(root, "node_modules", `f${i}.js`), "");
      const info = await gitInfo(root);
      expect(info.changedTotal).toBe(CHANGED_FILES_SHOWN + 200);
      const s = buildStatus({ ...base, git: info, live: { task: { id: "t", allowedPaths: info.changedFiles.map((f) => f.path) } }, events: [] });
      expect(s.git.changedFiles.length).toBe(CHANGED_FILES_SHOWN);
      expect(s.git.changedTotal).toBe(CHANGED_FILES_SHOWN + 200);
      expect(s.outsideApproved).toBe(false);
      expect(buildStatus({ ...base, git: info, live: { task: { id: "t", allowedPaths: [] } }, events: [] }).outsideApproved).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("case buttons", () => {
  it("are read again only when their inputs change", async () => {
    const root = mkdtempSync(join(tmpdir(), "dock-case-"));
    const stateDir = join(root, "state");
    mkdirSync(stateDir);
    const project = { id: "p", name: "P", path: root, stateDir } as unknown as Project;
    const manager = new EngineManager(join(root, "engine"), async () => ({ command: process.execPath, env: {} })) as unknown as {
      caseActions: (p: Project, live: unknown, alive: boolean, git: GitInfo) => Promise<unknown>;
      readCaseActions: () => Promise<unknown>;
    };
    const read = vi.fn(async () => ({ elevate: {}, resolver: {}, assessmentRetry: false, qaRetry: false }));
    manager.readCaseActions = read;
    try {
      const live = { stage: "BLOCKED", updatedAt: "1" };
      writeFileSync(join(stateDir, "current-task.json"), "{}");
      await manager.caseActions(project, live, false, git);
      await manager.caseActions(project, live, false, git);
      expect(read).toHaveBeenCalledTimes(1);
      writeFileSync(join(stateDir, "current-task.json"), '{"changed":true}');
      await manager.caseActions(project, live, false, git);
      expect(read).toHaveBeenCalledTimes(2);
      await manager.caseActions(project, { ...live, updatedAt: "2" }, false, git);
      expect(read).toHaveBeenCalledTimes(3);
      await manager.caseActions(project, { ...live, updatedAt: "2" }, false, { ...git, changedFiles: [{ status: " M", path: "a" }] });
      expect(read).toHaveBeenCalledTimes(4);
      await manager.caseActions(project, { ...live, updatedAt: "2" }, false, { ...git, changedFiles: [{ status: " M", path: "b" }] });
      expect(read).toHaveBeenCalledTimes(5);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
