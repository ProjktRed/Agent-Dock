import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { EngineInfo, Project, ProjectStatus } from "@shared/types";
import { ENGINE_DEFAULTS } from "./defaults";
import { lastError } from "./engine-errors";
import { readJson, writeJson } from "./lib/json-file";
import { gitInfo, run } from "./lib/git";
import { readPlan } from "./lib/plan";
import { buildStatus, type EngineControl, type EngineLive } from "./lib/status";
import { readActivity } from "./lib/usage";

// Bypass the bundler: engine modules are plain ESM files loaded at runtime from disk.
const nativeImport = new Function("url", "return import(url)") as (url: string) => Promise<Record<string, any>>;

export type ControlAction = "start" | "pause" | "resume" | "stop" | "stop-now" | "stop-after-task" | "elevate" | "resolve";

interface ProcessRecord {
  pid: number;
  startedAt: string;
  kind: "automation" | "elevate";
  args: string[];
}

const RECORD_FILE = "app-engine.json";

/** Launches the vendored engine (engine/src/cli.mjs) per project and reads its .state files. */
export class EngineManager {
  private modules = new Map<string, Promise<Record<string, any>>>();
  private alive = new Map<string, ProcessRecord>();
  private stopAfterTask = new Set<string>();

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

  /** A PID is only trusted if it is still a node/electron process (guards against PID reuse after a reboot). */
  private async pidAlive(pid: number): Promise<boolean> {
    try {
      process.kill(pid, 0);
    } catch {
      return false;
    }
    const list = await run("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { timeoutMs: 5000 });
    return /node|electron|codex cline/i.test(list.stdout);
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

  private async spawnEngine(project: Project, script: "cli.mjs" | "elevate-cli.mjs", args: string[]): Promise<ProcessRecord> {
    mkdirSync(project.stateDir, { recursive: true });
    const { command, env } = await this.resolveNode();
    const log = openSync(path.join(project.stateDir, "app-engine.log"), "a");
    try {
      // Detached with file-backed stdio: the engine keeps running safely if the window or app closes.
      const child = spawn(command, [path.join(this.engineDir, "src", script), ...args], {
        // Not the engine folder: processes the engine starts (a llama.cpp server keeps running on
        // purpose) inherit this, and a working directory inside the install blocks updates.
        cwd: project.stateDir,
        env,
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

  async start(project: Project, args: string[], resolveBlock = false): Promise<void> {
    if (await this.refreshAlive(project)) throw new Error("Automation is already running for this project.");
    const logBefore = (await this.engineLog(project, 10_000_000)).length;
    const record = await this.spawnEngine(project, "cli.mjs", resolveBlock ? [...args, "--resolve-block", "true"] : args);
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
  async control(project: Project, action: ControlAction, args: string[]): Promise<void> {
    const running = await this.refreshAlive(project);
    if (action === "start") return this.start(project, args);
    if (action === "stop-now") {
      if (!running) return;
      if (process.platform === "win32") await run("taskkill", ["/PID", String(running.pid), "/T", "/F"], { timeoutMs: 10_000 });
      else {
        try { process.kill(-running.pid, "SIGKILL"); } catch { /* already gone */ }
      }
      this.alive.delete(project.id);
      return;
    }
    if (action === "stop-after-task") {
      this.stopAfterTask.add(project.id);
      await (await this.state(project)).setControl("pause");
      return;
    }
    const state = await this.state(project);
    await state.setControl(action);
    if (action === "resume") this.stopAfterTask.delete(project.id);
    if ((action === "resume" || action === "resolve") && !running) await this.start(project, args, action === "resolve");
    if (action === "elevate" && !running) await this.spawnEngine(project, "elevate-cli.mjs", args);
  }

  /** Called on every poll: completes "stop after current task" once the engine has paused at the task boundary. */
  async afterPoll(project: Project, status: ProjectStatus): Promise<void> {
    if (this.stopAfterTask.has(project.id) && status.stage === "paused") {
      this.stopAfterTask.delete(project.id);
      await (await this.state(project)).setControl("stop");
    }
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
      gitInfo(project.path),
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
    return buildStatus({ projectId: project.id, live, control, processAlive: Boolean(record), pid: record?.pid ?? null, events, git, plan, elevate, resolver });
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
