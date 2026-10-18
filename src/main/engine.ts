import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, renameSync, statSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { EngineInfo, GitInfo, PlanProposal, Project, ProjectStatus, RunReport } from "@shared/types";
import { ENGINE_DEFAULTS } from "./defaults";
import { lastError } from "./engine-errors";
import { readJson, writeJson } from "./lib/json-file";
import { gitInfo, run } from "./lib/git";
import { readPlan } from "./lib/plan";
import { buildStatus, type EngineControl, type EngineLive } from "./lib/status";
import { readActivity } from "./lib/usage";

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
  ) {}

  private load(file: string) {
    if (!this.modules.has(file)) this.modules.set(file, nativeImport(pathToFileURL(path.join(this.engineDir, "src", file)).href));
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
      ? /node|electron|codex cline/i.test((await run("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { timeoutMs: 5000 })).stdout)
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
    mkdirSync(project.stateDir, { recursive: true });
    const { command, env } = await this.resolveNode();
    rotateEngineLog(project.stateDir);
    const log = openSync(path.join(project.stateDir, "app-engine.log"), "a");
    try {
      // Detached with file-backed stdio: the engine keeps running safely if the window or app closes.
      const child = spawn(command, [path.join(this.engineDir, "src", script), ...args], {
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
  async verifyActionLog(project: Project): Promise<{ ok: boolean; entries: number; head: string; lastAt: string | null; brokenAt?: number; reason?: string }> {
    return (await this.load("action-log.mjs")).verifyActionLog(project.stateDir);
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
    return buildStatus({ projectId: project.id, live, control, processAlive: Boolean(record), pid: record?.pid ?? null, events, git, plan, elevate, resolver, assessmentRetry, qaRetry });
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
