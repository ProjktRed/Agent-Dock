import { spawn } from "node:child_process";
import { wslEnv, wslKillTree, wslLaunch } from "./lib/wsl";
import { closeSync, existsSync, mkdirSync, openSync, renameSync, statSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { EngineInfo, GitInfo, ParallelRound, PlanProposal, Project, ProjectStatus, RunReport, SandboxResult, TaskBoard, TaskBoardUpdate, TaskBoardWriteResult } from "@shared/types";
import { ENGINE_DEFAULTS } from "./defaults";
import { lastError } from "./engine-errors";
import { readJson, writeJson } from "./lib/json-file";
import { gitInfo, run } from "./lib/git";
import { readPlan } from "./lib/plan";
import { buildStatus, parallelRound, pendingTaskApproval, type EngineControl, type EngineLive, type EngineParallelRound } from "./lib/status";
import { decideActionRequest, readActionRequests } from "./lib/action-requests";
import { readActivity } from "./lib/usage";
import { buildTaskBoard, writeTaskBoard } from "./lib/task-board";

// Bypass the bundler: engine modules are plain ESM files loaded at runtime from disk.
const nativeImport = new Function("url", "return import(url)") as (url: string) => Promise<Record<string, any>>;

export type ControlAction = "start" | "pause" | "resume" | "stop" | "stop-now" | "stop-after-task" | "elevate" | "resolve" | "retry-qa";

interface ProcessRecord {
  pid: number;
  startedAt: string;
  kind: "automation" | "elevate";
  args: string[];
}

const RECORD_FILE = "app-engine.json";
const GIT_MIN_AGE_MS = 2_000;
const GIT_MAX_AGE_MS = 10_000;

/** Launches the vendored engine (engine/src/cli.mjs) per project and reads its .state files. */
/** Keeps one previous engine log: past 10 MB, app-engine.log becomes app-engine.old.log. */
function rotateEngineLog(stateDir: string) {
  const file = path.join(stateDir, "app-engine.log");
  try { if (statSync(file).size > 10 * 1024 * 1024) renameSync(file, path.join(stateDir, "app-engine.old.log")); } catch { /* no log yet */ }
}

export class EngineManager {
  private modules = new Map<string, Promise<Record<string, any>>>();
  private alive = new Map<string, ProcessRecord>();
  private stopAfterTask = new Set<string>();
  private verifiedPids = new Set<number>();
  /** git state per project, refreshed at most every GIT_MAX_AGE_MS (sooner when the engine logs activity). */
  private gitCache = new Map<string, { at: number; activitySize: number; value: GitInfo }>();

  constructor(
    readonly engineDir: string,
    private resolveNode: () => Promise<{ command: string; env: NodeJS.ProcessEnv }>,
    /** Installed engine files that differ from the build's list (packaged builds); none = safe to load. */
    readonly fileProblems: () => string[] = () => [],
  ) {}

  /** Engine code is never loaded or started once its installed files were changed. */
  private assertIntact() {
    const problems = this.fileProblems();
    if (problems.length) throw new Error(`Agent Dock's engine files were changed outside Agent Dock (${problems.slice(0, 3).join("; ")}${problems.length > 3 ? "; …" : ""}). Reinstall or update Agent Dock before running automation.`);
  }

  private load(file: string) {
    if (!this.modules.has(file)) {
      try { this.assertIntact(); } catch (error) { return Promise.reject(error); }
      this.modules.set(file, nativeImport(pathToFileURL(path.join(this.engineDir, "src", file)).href));
    }
    return this.modules.get(file)!;
  }

  async info(): Promise<EngineInfo> {
    let codex: Record<string, string> = {};
    let claude: Record<string, string> = {};
    try {
      const worker = await this.load("codex-worker.mjs");
      codex = { qa: worker.QA_MODEL, assessment: worker.ASSESSMENT_MODEL, resolver: worker.RESOLVER_MODEL, elevate: worker.ELEVATE_MODEL, reasoning: worker.CODEX_REASONING };
      const claudeWorker = await this.load("claude-worker.mjs");
      claude = { ...claudeWorker.CLAUDE_MODELS };
    } catch (error) {
      console.error("Engine model constants unavailable", error);
    }
    return { dir: this.engineDir, orchestratorModels: { codex, claude }, defaults: ENGINE_DEFAULTS };
  }

  /** The engine's own task validation (bounded, relative allowedPaths, qaCommand present). */
  async validateTask(task: unknown): Promise<void> {
    const loop = await this.load("node-loop.mjs");
    loop.validateTask(task);
  }

  private recordPath(project: Project) {
    return path.join(project.stateDir, RECORD_FILE);
  }

  /**
   * A PID is only trusted if it is still a node/electron process (guards against PID reuse after a
   * reboot). The process list is checked once per PID: while that process keeps running its PID
   * cannot be reused, so later polls only ask whether it still exists (no process started).
   */
  private async pidAlive(pid: number): Promise<boolean> {
    try {
      process.kill(pid, 0);
    } catch {
      this.verifiedPids.delete(pid);
      return false;
    }
    if (this.verifiedPids.has(pid)) return true;
    const ok = process.platform === "win32"
      ? /node|electron|codex cline|wsl/i.test((await run("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { timeoutMs: 5000 })).stdout)
      : await readFile(`/proc/${pid}/cmdline`, "utf8").then((cmd) => /node|electron/i.test(cmd), () => true);
    if (ok) this.verifiedPids.add(pid);
    return ok;
  }

  async refreshAlive(project: Project): Promise<ProcessRecord | null> {
    const known = this.alive.get(project.id) ?? (await readJson<ProcessRecord | null>(this.recordPath(project), null));
    if (known && (await this.pidAlive(known.pid))) {
      this.alive.set(project.id, known);
      return known;
    }
    this.alive.delete(project.id);
    return null;
  }

  isAlive(projectId: string) {
    return this.alive.has(projectId);
  }

  private async spawnEngine(project: Project, script: "cli.mjs" | "elevate-cli.mjs", args: string[], envDelta: NodeJS.ProcessEnv = {}): Promise<ProcessRecord> {
    this.assertIntact();
    mkdirSync(project.stateDir, { recursive: true });
    // WSL isolation: wsl.exe runs the engine (and every CLI it starts) inside the distro.
    const inWsl = process.platform === "win32" && project.wsl?.enabled && project.wsl.distro.trim();
    const launch = inWsl
      ? { ...wslLaunch(project.wsl!.distro.trim(), path.join(this.engineDir, "src", script), project.stateDir, args), env: { ...process.env, WSLENV: wslEnv(process.env.WSLENV, Object.keys(envDelta)) } }
      : null;
    const { command, env } = launch ?? (await this.resolveNode());
    rotateEngineLog(project.stateDir);
    const log = openSync(path.join(project.stateDir, "app-engine.log"), "a");
    try {
      // Detached with file-backed stdio: the engine keeps running safely if the window or app closes.
      const child = spawn(command, launch ? launch.args : [path.join(this.engineDir, "src", script), ...args], {
        // Not the engine folder: processes the engine starts (a llama.cpp server keeps running on
        // purpose) inherit this, and a working directory inside the install blocks updates.
        cwd: project.stateDir,
        env: { ...env, ...envDelta },
        detached: true,
        windowsHide: true,
        stdio: ["ignore", log, log],
      });
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      child.unref();
      const record: ProcessRecord = { pid: child.pid!, startedAt: new Date().toISOString(), kind: script === "cli.mjs" ? "automation" : "elevate", args };
      await writeJson(this.recordPath(project), record);
      this.alive.set(project.id, record);
      return record;
    } finally {
      closeSync(log);
    }
  }

  async start(project: Project, args: string[], resolveBlock = false, envDelta: NodeJS.ProcessEnv = {}): Promise<void> {
    if (await this.refreshAlive(project)) throw new Error("Automation is already running for this project.");
    rotateEngineLog(project.stateDir);
    // A stop left by the previous run (a run limit, Stop) would end this one before it starts.
    const state = await this.state(project);
    if ((await state.readControl()).stopAfterSafePoint) await state.setControl("resume", { source: "app" });
    const logBefore = (await this.engineLog(project, 10_000_000)).length;
    const record = await this.spawnEngine(project, "cli.mjs", resolveBlock ? [...args, "--resolve-block", "true"] : args, envDelta);
    // Preflight (provider, model, orchestrator sign-in) fails within seconds; report it instead of silently going idle.
    await new Promise((resolve) => setTimeout(resolve, 2500));
    if (!(await this.pidAlive(record.pid))) {
      this.alive.delete(project.id);
      // A run with nothing to do can finish this fast: its result receipt is not a startup failure.
      const finished = await stat(path.join(project.stateDir, "loop-result.json")).then((s) => s.mtimeMs >= Date.parse(record.startedAt) - 1000, () => false);
      if (finished) return;
      const output = (await this.engineLog(project, 10_000_000)).slice(logBefore);
      throw new Error(`The engine exited during startup. ${lastError(output)}`);
    }
  }

  private async state(project: Project) {
    const mod = await this.load("dashboard-state.mjs");
    return new mod.DashboardState({ stateDir: project.stateDir });
  }

  /** Same semantics as the engine dashboard (engine/src/dashboard-cli.mjs onControl). */
  async control(project: Project, action: ControlAction, args: string[], envDelta: NodeJS.ProcessEnv = {}, source = "app"): Promise<void> {
    this.gitCache.delete(project.id);
    const running = await this.refreshAlive(project);
    if (action === "start") return this.start(project, args, false, envDelta);
    if (action === "stop-now") {
      if (!running) return;
      // WSL isolation: the engine and its CLIs live inside the distro, outside wsl.exe's Windows process tree.
      if (process.platform === "win32" && project.wsl?.enabled && project.wsl.distro.trim()) {
        const own = await readJson<{ pid?: number; platform?: string; startedAt?: string } | null>(path.join(project.stateDir, "engine-pid.json"), null);
        if (own?.platform === "linux" && Number.isInteger(own.pid) && Date.parse(own.startedAt ?? "") >= Date.parse(running.startedAt) - 60_000) {
          const kill = wslKillTree(project.wsl.distro.trim(), own.pid!);
          await run(kill.command, kill.args, { timeoutMs: 15_000 });
        }
      }
      if (process.platform === "win32") await run("taskkill", ["/PID", String(running.pid), "/T", "/F"], { timeoutMs: 10_000 });
      else {
        try { process.kill(-running.pid, "SIGKILL"); } catch { /* already gone */ }
      }
      this.alive.delete(project.id);
      // The killed engine writes nothing; record the stop so it is not taken for an interruption.
      await (await this.state(project)).record({ type: "stopped", reason: "stop-now", source }).catch(() => undefined);
      return;
    }
    if (action === "stop-after-task") {
      this.stopAfterTask.add(project.id);
      await (await this.state(project)).setControl("pause", { source });
      return;
    }
    const state = await this.state(project);
    await state.setControl(action, { source });
    if (action === "resume") this.stopAfterTask.delete(project.id);
    if ((action === "resume" || action === "resolve" || action === "retry-qa") && !running) await this.start(project, args, action === "resolve", envDelta);
    if (action === "elevate" && !running) await this.spawnEngine(project, "elevate-cli.mjs", args, envDelta);
  }

  /** Called on every poll: completes "stop after current task" once the engine has paused at the task boundary. */
  async afterPoll(project: Project, status: ProjectStatus): Promise<void> {
    if (this.stopAfterTask.has(project.id) && status.stage === "paused") {
      this.stopAfterTask.delete(project.id);
      await (await this.state(project)).setControl("stop", { source: "app" });
    }
  }

  /** The project's tamper-evident action log, checked entry by entry (engine/src/action-log.mjs). */
  /** The action log key: entries the app writes are signed with it, and verification checks signatures. */
  async useLogKey(hex: string | null): Promise<void> {
    (await this.load("action-log.mjs")).useActionLogKey(hex);
  }

  /** With a new key: records, signed, where each log written before it ends, so those entries still verify. */
  async checkpointLegacyLogs(stateDirs: string[]): Promise<void> {
    const actionLog = await this.load("action-log.mjs");
    for (const stateDir of stateDirs) await actionLog.checkpointLegacyLog(stateDir).catch((error: unknown) => console.error("Action log checkpoint failed", stateDir, error));
  }

  /**
   * Settings › Experimental sandbox for checks: engine/src/sandbox-cli.mjs in its own process (the sandbox runtime
   * never loads into the app), its one JSON line back. install can wait on an administrator prompt.
   */
  async sandbox(command: "status" | "codex-status" | "install" | "uninstall" | "self-test", args: string[] = []): Promise<SandboxResult> {
    this.assertIntact();
    const { command: node, env } = await this.resolveNode();
    return new Promise((resolve) => {
      const child = spawn(node, [path.join(this.engineDir, "src", "sandbox-cli.mjs"), command, ...args], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let out = "", err = "";
      const timer = setTimeout(() => child.kill(), 10 * 60_000);
      child.stdout.setEncoding("utf8").on("data", (c: string) => (out += c));
      child.stderr.setEncoding("utf8").on("data", (c: string) => (err = (err + c).slice(-2000)));
      child.on("error", (error) => { clearTimeout(timer); resolve({ ok: false, problem: error.message }); });
      child.on("close", () => {
        clearTimeout(timer);
        const line = out.trim().split(/\r?\n/).pop() ?? "";
        try { resolve(JSON.parse(line) as SandboxResult); } catch { resolve({ ok: false, problem: (err || out || "the sandbox helper gave no answer").trim().slice(-600) }); }
      });
    });
  }

  /** Approve each task: your answer for the task waiting before Implementation; false when it is not the one waiting. */
  async decideTask(project: Project, taskId: string, decision: "approve" | "reject", source = "app"): Promise<boolean> {
    if (!(await this.refreshAlive(project))) return false;
    const events = await readActivity(project.stateDir, 200).catch(() => []);
    if (pendingTaskApproval(events, true)?.taskId !== taskId) return false;
    await (await this.state(project)).setControl(decision === "approve" ? "approve-task" : "reject-task", { source, reason: taskId });
    return true;
  }

  /** Ask instead of refuse: answers one waiting agent action (first answer wins). */
  decideAction(project: Project, id: string, decision: "allow" | "deny", by: string): Promise<boolean> {
    return decideActionRequest(project.stateDir, id, decision, by);
  }

  /** expect: the newest entry the app recorded earlier (kept outside the state folder); the log must still contain it unchanged. */
  async verifyActionLog(project: Project, expect: { seq: number; head: string } | null = null): Promise<{ ok: boolean; entries: number; head: string; lastAt: string | null; lastSeq?: number; brokenAt?: number; reason?: string; signed?: number; unsigned?: number }> {
    return (await this.load("action-log.mjs")).verifyActionLog(project.stateDir, { expect });
  }

  /** Sets the blocked or waiting task aside (work stashed, task deferred); the next Run starts a fresh Assessment. */
  async setAside(project: Project, source = "app"): Promise<{ id: string; stash: { message: string } | null }> {
    if (await this.refreshAlive(project)) throw new Error("Stop the engine before setting the task aside.");
    this.gitCache.delete(project.id);
    return (await this.load("defer-task.mjs")).setAsideTask({ workspace: project.path, stateDir: project.stateDir, state: await this.state(project), source });
  }

  /** Adds a line to the project's Activity (and its action log). */
  async recordEvent(project: Project, event: Record<string, unknown>): Promise<void> {
    await (await this.state(project)).record(event);
  }

  /** The engine's notification module: one set of channel rules and message shapes for app and engine. */
  notifyModule() {
    return this.load("notify.mjs");
  }

  /** The engine's own redaction (exact secret values plus credential patterns) and action-log check, for the diagnostics export. */
  async diagnosticsTools(secrets: string[]): Promise<{ redact: (text: string) => string; verifyActionLog: (stateDir: string) => Promise<unknown> }> {
    const redact = await this.load("redact.mjs");
    const actionLog = await this.load("action-log.mjs");
    redact.useSecretValues(secrets);
    return { redact: (text) => redact.redactText(text), verifyActionLog: (stateDir) => actionLog.verifyActionLog(stateDir) };
  }

  /** Finished runs, newest first. */
  async runs(project: Project): Promise<RunReport[]> {
    return (await this.load("run-budget.mjs")).listRuns(project.stateDir);
  }

  /** Supervisor plan proposals (engine/src/plan-stewardship.mjs), checked against today's plan. */
  async planProposals(project: Project): Promise<PlanProposal[]> {
    return (await this.load("plan-stewardship.mjs")).listPlanProposals({ stateDir: project.stateDir, workspace: project.path });
  }

  /** Approving while the engine runs leaves it to the next task boundary; with no engine it is committed now (clean tree only). */
  async decidePlanProposal(project: Project, id: string, decision: "approve" | "dismiss", source = "app"): Promise<PlanProposal[]> {
    const mod = await this.load("plan-stewardship.mjs");
    const state = await this.state(project);
    await mod.decidePlanProposal({ stateDir: project.stateDir, id, decision, source, state });
    if (decision === "approve" && !(await this.refreshAlive(project))) await mod.applyApprovedPlanProposals({ stateDir: project.stateDir, workspace: project.path, state });
    this.gitCache.delete(project.id);
    return this.planProposals(project);
  }

  isStoppingAfterTask(projectId: string) {
    return this.stopAfterTask.has(projectId);
  }

  /** The Task board as status() builds it, with what is being worked on now. */
  async taskBoard(project: Project): Promise<TaskBoard> {
    const record = await this.refreshAlive(project);
    const live = await readJson<EngineLive | null>(path.join(project.stateDir, "live.json"), null).catch(() => null);
    return buildTaskBoard(project.stateDir, await readPlan(project.path, live?.task ?? {}), live, Boolean(record));
  }

  /** Saves a Task board change (priority order, reset, grouping). A reorder made on a stale board is rejected with the current one. */
  async setTaskBoard(project: Project, update: TaskBoardUpdate): Promise<TaskBoardWriteResult> {
    const plan = await readPlan(project.path);
    return writeTaskBoard(project.stateDir, plan, update, { board: () => this.taskBoard(project) });
  }

  async status(project: Project): Promise<ProjectStatus> {
    const record = await this.refreshAlive(project);
    const [live, control, events, git] = await Promise.all([
      readJson<EngineLive | null>(path.join(project.stateDir, "live.json"), null).catch(() => null),
      readJson<EngineControl>(path.join(project.stateDir, "control.json"), {}).catch(() => ({})),
      readActivity(project.stateDir, 200).catch(() => []),
      this.git(project),
    ]);
    const plan = await readPlan(project.path, live?.task ?? {});
    let elevate = { available: false, reason: "No manual-review case" as string | null };
    let resolver = { available: false, reason: "No blocked case" as string | null };
    if (live && existsSync(project.stateDir)) {
      try {
        const cases = await this.load("elevate-case.mjs");
        const c = await cases.loadElevateCase(project.stateDir);
        const a = cases.elevateAvailability({ live, fingerprint: c.fingerprint });
        elevate = { available: Boolean(a.available), reason: a.reason ?? null };
      } catch {
        // no evidence on disk
      }
      if (live.stage === "BLOCKED") {
        try {
          const blocked = await this.load("blocked-resolver.mjs");
          const a = blocked.resolverAvailability({ live, input: await blocked.loadResolverCase(project.stateDir) });
          resolver = { available: Boolean(a.available) && !(live as { resolverRequested?: boolean }).resolverRequested, reason: a.reason ?? null };
        } catch {
          // incomplete case
        }
      }
    }
    // Blocked before any task was underway (Assessment itself stopped): nothing for the Resolver,
    // and restarting the engine simply runs Assessment again.
    let assessmentRetry = false;
    // Blocked with a finished, in-scope attempt (QA could not run, e.g. a tool or permission
    // problem the user has since fixed): Retry QA reviews that attempt again.
    let qaRetry = false;
    if (live?.stage === "BLOCKED" && !record) {
      const current = await readJson<{ automation?: { recovery?: { phase?: string } } } | null>(path.join(project.stateDir, "current-task.json"), null).catch(() => null);
      const recovery = current?.automation?.recovery;
      const phase = recovery?.phase;
      if (!resolver.available) assessmentRetry = !phase || phase === "passed";
      try {
        const policy = await this.load("recovery-policy.mjs");
        qaRetry = Boolean(policy.qaRetryAvailability(recovery ?? null).available);
      } catch {
        // engine without Retry QA
      }
    }
    const board = await buildTaskBoard(project.stateDir, plan, live, Boolean(record)).catch(() => undefined);
    const parallel = await this.parallelRound(project, Boolean(record)).catch(() => null);
    const actionRequests = record ? await readActionRequests(project.stateDir).catch(() => []) : [];
    return { ...buildStatus({ projectId: project.id, live, control, processAlive: Boolean(record), pid: record?.pid ?? null, events, git, plan, elevate, resolver, assessmentRetry, qaRetry }), ...(board ? { board } : {}), ...(parallel ? { parallel } : {}), taskApproval: pendingTaskApproval(events, Boolean(record)), actionRequests };
  }

  /** A parallel round in progress: each task's live state from its engine's folder (<state>/parallel/<task>/live.json). */
  private async parallelRound(project: Project, processAlive: boolean): Promise<ParallelRound | null> {
    if (!processAlive) return null;
    const round = await readJson<EngineParallelRound | null>(path.join(project.stateDir, "parallel-round.json"), null).catch(() => null);
    if (!round || round.endedAt || !Array.isArray(round.tasks)) return null;
    const lives: Record<string, EngineLive | null> = {};
    await Promise.all(round.tasks.map(async (task) => {
      // Only a folder name: never a path outside the run's parallel folder.
      if (typeof task?.folder !== "string" || !task.folder || path.basename(task.folder) !== task.folder) return;
      lives[task.folder] = await readJson<EngineLive | null>(path.join(project.stateDir, "parallel", task.folder, "live.json"), null).catch(() => null);
    }));
    return parallelRound(round, lives, processAlive);
  }

  /**
   * git state without running five git commands on every poll: reused for up to GIT_MAX_AGE_MS,
   * refreshed sooner (after GIT_MIN_AGE_MS) when the engine has logged new activity.
   */
  private async git(project: Project): Promise<GitInfo> {
    const cached = this.gitCache.get(project.id);
    const activitySize = await stat(path.join(project.stateDir, "activity.ndjson")).then((s) => s.size, () => 0);
    const age = cached ? Date.now() - cached.at : Infinity;
    if (cached && (age < GIT_MIN_AGE_MS || (age < GIT_MAX_AGE_MS && activitySize === cached.activitySize))) return cached.value;
    const value = await gitInfo(project.path);
    this.gitCache.set(project.id, { at: Date.now(), activitySize, value });
    return value;
  }

  async engineLog(project: Project, maxBytes = 20_000): Promise<string> {
    try {
      const text = await readFile(path.join(project.stateDir, "app-engine.log"), "utf8");
      return text.slice(-maxBytes);
    } catch {
      return "";
    }
  }
}
