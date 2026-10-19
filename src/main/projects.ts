import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AddProjectRequest, DirectoryInspection, EngineEvent, Project } from "@shared/types";
import { isGitRepo, run } from "./lib/git";
import { parseImplementationPlan, PLAN_FILE, STARTER_PLAN } from "./lib/plan";

export async function inspectDirectory(dir: string): Promise<DirectoryInspection> {
  const exists = existsSync(dir);
  const repo = exists && isGitRepo(dir);
  let branch: string | null = null;
  let remote: string | null = null;
  if (repo) {
    const [b, r] = await Promise.all([run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir }), run("git", ["remote", "get-url", "origin"], { cwd: dir })]);
    branch = b.code === 0 ? b.stdout.trim() : null;
    remote = r.code === 0 ? r.stdout.trim() : null;
  }
  let planFile: string | null = null;
  let planSummary: string | null = null;
  if (exists && existsSync(path.join(dir, PLAN_FILE))) {
    planFile = PLAN_FILE;
    const plan = parseImplementationPlan(await readFile(path.join(dir, PLAN_FILE), "utf8"));
    planSummary = `${plan.phases.length} phases, ${plan.total} tasks (${plan.completed} done)`;
  }
  return { path: dir, exists, isRepo: repo, branch, remote, planFile, planSummary, suggestedName: path.basename(dir) };
}

function newProject(fields: { name: string; path: string; repoUrl: string | null; objective: string }, stateRoot: string): Project {
  const id = randomUUID();
  return {
    id,
    name: fields.name.trim(),
    path: fields.path,
    repoUrl: fields.repoUrl,
    objective: fields.objective.trim(),
    description: "",
    createdAt: new Date().toISOString(),
    archived: false,
    stateDir: path.join(stateRoot, id, "state"),
    roleOverrides: {},
    workflowOverrides: {},
  };
}

/** Registers, clones or creates a workspace. Never deletes or overwrites existing files. */
export async function addProject(request: AddProjectRequest, existing: Project[], stateRoot: string): Promise<Project> {
  const name = request.name.trim();
  if (!name) throw new Error("Project name is required.");
  if (existing.some((p) => p.name.toLowerCase() === name.toLowerCase())) throw new Error(`A project named “${name}” is already registered.`);

  if (request.mode === "local") {
    if (!existsSync(request.path)) throw new Error("That folder does not exist.");
    if (existing.some((p) => path.resolve(p.path) === path.resolve(request.path))) throw new Error("That folder is already registered.");
    const info = await inspectDirectory(request.path);
    return newProject({ name, path: request.path, repoUrl: info.remote, objective: request.objective }, stateRoot);
  }

  if (request.mode === "github") {
    const url = request.url.trim();
    if (!/^(https:\/\/|git@)/.test(url)) throw new Error("Enter an https:// or git@ repository URL.");
    const target = path.join(request.parentDir, name);
    if (existsSync(target)) {
      if (!isGitRepo(target)) throw new Error(`${target} already exists and is not a Git repository.`);
    } else {
      const args = ["clone", ...(request.branch.trim() ? ["--branch", request.branch.trim()] : []), url, target];
      const result = await run("git", args, { timeoutMs: 10 * 60_000 });
      if (result.code !== 0) throw new Error(`git clone failed: ${result.stderr.trim().split(/\r?\n/).slice(-2).join(" ")}`);
    }
    return newProject({ name, path: target, repoUrl: url, objective: request.objective }, stateRoot);
  }

  const target = path.join(request.parentDir, name);
  if (existsSync(target)) throw new Error(`${target} already exists. Choose “Local project” to register it.`);
  await mkdir(target, { recursive: true });
  if (request.starterPlan) await writeFile(path.join(target, PLAN_FILE), STARTER_PLAN);
  if (request.initGit) {
    const init = await run("git", ["init", "-b", "main"], { cwd: target });
    if (init.code !== 0) throw new Error(`git init failed: ${init.stderr.trim()}`);
    // The engine needs a clean baseline commit (it reads HEAD before every task).
    await writeFile(path.join(target, ".gitignore"), "node_modules/\n");
    await run("git", ["add", "-A"], { cwd: target });
    const commit = await run("git", ["commit", "-m", "Initial workspace"], { cwd: target });
    if (commit.code !== 0) throw new Error(`Workspace created, but the initial commit failed (configure git user.name/user.email): ${commit.stderr.trim()}`);
  }
  return newProject({ name, path: target, repoUrl: null, objective: request.objective }, stateRoot);
}

export interface TaskHistoryEntry {
  taskId: string;
  outcome: "approved" | "failed" | "attention" | "blocked" | "stopped";
  attempts: number;
  finishedAt: string;
  summary: string;
}

/** Task outcomes from the engine's append-only activity log, newest first. */
/** Same rule as engine/src/task-archive.mjs. */
const taskFileName = (id: string) => `${String(id).replace(/[^\w.-]+/g, "_").slice(0, 120)}.json`;

/** Task ids whose definitions the engine kept (<state>/tasks), so they can run again. */
export async function savedTaskIds(stateDir: string): Promise<Set<string>> {
  const names = await readdir(path.join(stateDir, "tasks")).catch(() => [] as string[]);
  return new Set(names.filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5)));
}
export const canRerun = (saved: Set<string>, taskId: string) => saved.has(taskFileName(taskId).slice(0, -5));

/**
 * Task history › Run again: copies the saved task under a new id (so it never collides with the old
 * task's recovery state) to <state>/rerun-task.json, the one-shot first task of the next start.
 */
export async function prepareRerun(stateDir: string, taskId: string, now = Date.now()): Promise<string> {
  let task: Record<string, unknown> | null = null;
  try { task = JSON.parse(await readFile(path.join(stateDir, "tasks", taskFileName(taskId)), "utf8")); } catch { /* not kept */ }
  if (!task || typeof task.prompt !== "string" || !Array.isArray(task.allowedPaths) || typeof task.qaCommand !== "string") throw new Error(`Task ${taskId} was not kept, so it cannot run again (tasks are kept from Agent Dock 0.34 on).`);
  const base = String(task.id ?? taskId).replace(/-again-[a-z0-9]+$/, "");
  const { savedAt: _savedAt, ...definition } = task;
  const file = path.join(stateDir, "rerun-task.json");
  await writeFile(file, JSON.stringify({ ...definition, id: `${base}-again-${now.toString(36)}`, name: `${String(task.name ?? base)} (again)` }, null, 2));
  return file;
}

export function taskHistory(events: EngineEvent[]): TaskHistoryEntry[] {
  const outcomes: Record<string, TaskHistoryEntry["outcome"]> = {
    "qa-pass": "approved",
    "manual-review": "attention",
    "user-attention": "attention",
    blocked: "blocked",
    stopped: "stopped",
  };
  const latest = new Map<string, TaskHistoryEntry>();
  for (const event of events) {
    const outcome = outcomes[event.type];
    if (!outcome || !event.taskId) continue;
    latest.set(event.taskId, {
      taskId: event.taskId,
      outcome,
      attempts: event.attempt ?? 0,
      finishedAt: event.timestamp,
      summary: String(event.qa ?? "").split(/\r?\n/)[0].slice(0, 200),
    });
  }
  return [...latest.values()].sort((a, b) => b.finishedAt.localeCompare(a.finishedAt));
}
