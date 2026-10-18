import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { diagnostic } from "./diagnostics.mjs";
import { elevateAvailability, loadElevateCase } from "./elevate-case.mjs";
import { migrateRecoveryState, qaRetryAvailability, recoveryClassification } from './recovery-policy.mjs';
import {loadResolverCase,resolverAvailability} from './blocked-resolver.mjs';
import { selectedAutoSkills } from './task-handoff-skill.mjs';
import { appendAction, flushActionLog } from './action-log.mjs';
import { redactDeep } from './redact.mjs';
export { flushActionLog };

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

const writeQueues = new Map();

async function replaceJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  for (let attempt = 0;; attempt++) {
    try { await rename(temporary, file); break; }
    catch (error) {
      if (!['EPERM', 'EACCES'].includes(error.code) || attempt === 49) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(25, 5 * (attempt + 1))));
    }
  }
  diagnostic("STATE_WRITTEN", { file });
}

export function atomicWriteJson(file, value) {
  const previous = writeQueues.get(file) ?? Promise.resolve();
  const operation = previous.catch(() => {}).then(() => replaceJson(file, value));
  writeQueues.set(file, operation);
  return operation.finally(() => {
    if (writeQueues.get(file) === operation) writeQueues.delete(file);
  });
}

export class DashboardState {
  constructor({ stateDir }) {
    this.stateDir = path.resolve(stateDir);
    this.livePath = path.join(this.stateDir, "live.json");
    this.controlPath = path.join(this.stateDir, "control.json");
    this.activityPath = path.join(this.stateDir, "activity.ndjson");
    this.live = null;
  }

  async initialize({ task, workspace, maxAttempts, contextTokens, timeoutSeconds, model, provider }) {
    const codexOperation = this.live?.codexOperation ?? null;
    this.live = {
      task: { ...task, id: task.id, name: task.name ?? task.id, prompt: task.prompt },
      workspace,
      stage: "waiting",
      clineStatus: "idle",
      qaStatus: "waiting",
      attempt: 0,
      maxAttempts,
      latestQa: "",
      manualReview: false,
      userAttention: false,
      userAttentionReason: null,
      correctionCount: 0,
      correctionHistory: [],
      activeReasoningRole: null,
      interruptedOperation: null,
      codexLimitMessage: null,
      codexRetryAt: null,
      codexOperation,
      elevateRunning: false,
      elevateStartedAt: null,
      elevateUsedForFingerprint: null,
      elevateResult: null,
      cline: { startedAt: null, finishedAt: null, durationMs: null, pid: null, contextTokens: contextTokens ?? null, timeoutSeconds: timeoutSeconds ?? null, model: model ?? null, provider: provider ?? null },
      qaChecks: { tests: "NOT RUN", typecheck: "NOT RUN", lint: "NOT RUN", build: "NOT RUN", scopeCheck: "NOT RUN" },
      updatedAt: new Date().toISOString(),
    };
    await atomicWriteJson(this.livePath, this.live);
    if ((await readJson(this.controlPath, null)) === null) {
      await atomicWriteJson(this.controlPath, {
        pauseAfterCurrent: false,
        stopAfterSafePoint: false,
        resumeGeneration: 0,
      });
    }
    const skills = selectedAutoSkills(task).map((skill) => skill.name);
    await this.appendEvent({ type: "task-loaded", taskId: task.id, ...(skills.length ? { skills } : {}) });
  }

  async record(event) {
    event = redactDeep(event);
    this.live ??= await this.readLive();
    const next = { ...this.live, updatedAt: new Date().toISOString() };
    if(event.type==='recovery-state') {
      Object.assign(next,event.recovery);
      if(event.consumeCodexResult) next.codexOperation=null;
    }
    if(event.type==='codex-operation-consumed') next.codexOperation=null;
    if(event.type==='known-issues-selected')next.knownIssues=event.knownIssues;
    if(['codex-assessing','codex-qa-started','sol-reassessment-started','resolver-started'].includes(event.type)) {
      next.activeReasoningRole=event.type==='resolver-started'?'Resolver':event.type==='codex-qa-started'?'QA':event.type==='sol-reassessment-started'?'Elevation':'Assessment';
      next.activeReasoningModel=event.model;
      next.assessmentRunning=next.activeReasoningRole==='Assessment';
    }
    if(event.type==='role-started'){next.activeReasoningRole=event.roleName??'Workflow role';next.activeReasoningModel=event.model;next.assessmentRunning=false;}
    if(event.type==='role-result'||event.type==='role-error')(next.roleResults??=[]).push({roleName:event.roleName,stage:event.stage,verdict:event.verdict??null,summary:event.summary??event.message??'',error:event.type==='role-error',at:new Date().toISOString()}),next.roleResults=next.roleResults.slice(-20);
    if(['codex-finished','codex-qa-finished','sol-reassessment-finished','resolver-finished','resolver-error','blocked','waiting-for-codex','role-finished','role-error'].includes(event.type)) {
      next.activeReasoningRole=null;next.assessmentRunning=false;
    }
    if (event.attempt !== undefined) next.attempt = event.attempt;
    if (event.qa !== undefined) next.latestQa = event.qa;
    if (event.type === "cline-started") {
      next.cline = { ...(next.cline ?? {}), startedAt: event.startedAt ?? new Date().toISOString(), finishedAt: null, durationMs: null, pid: event.pid ?? null };
    } else if (event.type === "cline-process-started") {
      next.cline = { ...(next.cline ?? {}), startedAt: event.startedAt ?? next.cline?.startedAt, pid: event.pid ?? null };
    } else if (event.type === "cline-finished") {
      next.cline = { ...(next.cline ?? {}), finishedAt: event.finishedAt ?? new Date().toISOString(), durationMs: event.durationMs ?? next.cline?.durationMs, pid: null };
    }
    if (event.qaChecks) next.qaChecks = { ...(next.qaChecks ?? {}), ...event.qaChecks };
    if(event.type==='resolver-started') {next.resolverRunning=true;next.resolverRequested=false;next.resolverStartedAt=event.startedAt;next.resolverModel=event.model;}
    if(['resolver-finished','resolver-error','waiting-for-codex','blocked'].includes(event.type))next.resolverRunning=false;
    if(event.type==='resolver-error') {next.resolverRequested=false;next.resolverResult={status:'blocked',failureReason:event.message};}
    if(event.type==='resolver-limit') {next.resolverRunning=false;next.resolverRequested=false;next.resolverResult={status:'blocked',failureReason:event.message};}
    if(event.type==='resolver-result') {next.resolverRunning=false;next.resolverRequested=false;next.resolverResult=event.result;next.resolverUsedForFingerprint=event.fingerprint;next.stage=event.ready?'USER_ATTENTION':'BLOCKED';if(event.ready)next.blockedReason=null;}
    if (event.type === "codex-qa-started" && event.source === "manual-elevate") next.elevateRunning = false;
    if (event.type === "sol-reassessment-started") {
      next.elevateRunning = true;
      next.elevateStartedAt = event.startedAt ?? new Date().toISOString();
      next.elevateModel = event.model ?? next.elevateModel ?? null;
      // Keep the previous result visible during a usage-limited retry.
      next.elevateAutomatic = event.automatic === true;
      next.elevateTriggeredBy = event.triggeredBy ?? 'User requested';
    } else if (event.type === "sol-reassessment-finished") {
      next.elevateRunning = false;
    } else if (event.type === "elevate-result") {
      next.elevateRunning = Boolean(event.keepRunning);
      next.elevateResult = event.elevateResult ?? null;
      next.elevateUsedForFingerprint = event.fingerprint ?? next.elevateUsedForFingerprint;
      if (event.elevateResult?.kind === "qa-pass") {
        next.stage = "pass";
        next.clineStatus = "idle";
        next.qaStatus = "pass";
        next.manualReview = false;
      } else {
        next.stage = "USER_ATTENTION";
        next.clineStatus = "idle";
        next.qaStatus = "fail";
        next.manualReview = false;
        next.userAttention = true;
      }
    } else if (event.type === "elevate-cleared") {
      next.elevateRunning = false;
    } else if (event.type === "elevate-launch-failed") {
      next.elevateRunning = false;
      next.elevateUsedForFingerprint = null;
      next.elevateResult = { kind: "blocked", label: "Blocked", reason: event.qa ?? event.message ?? "Elevate could not start." };
      next.stage = "BLOCKED";
      next.clineStatus = "idle";
      next.qaStatus = "fail";
      next.manualReview = false;
    }
    if (["codex-finished", "codex-qa-finished", "sol-reassessment-finished", "resolver-finished", "role-finished"].includes(event.type) && event.codexOperation?.status === "completed") {
      next.codexOperation = event.codexOperation;
    } else if (["codex-assessing", "codex-qa-started", "cline-started", "qa-pass", "manual-review", "loop-complete"].includes(event.type)) {
      next.codexOperation = null;
    }

    const transitions = {
      "codex-assessing": ["current-task", "idle", "waiting", false],
      "codex-finished": ["current-task", "idle", "waiting", false],
      "cline-started": ["cline-working", "running", "waiting", false],
      "cline-finished": ["cline-complete", "idle", "waiting", false],
      "codex-qa-started": ["codex-qa", "idle", "running", false],
      "codex-qa-finished": ["codex-qa", "idle", "waiting", false],
      "loop-complete": ["complete", "idle", "pass", false],
      queued: ["waiting", "idle", "waiting", false],
      "task-start": ["current-task", "idle", "waiting", false],
      "cline-running": ["cline-working", "running", "waiting", false],
      "cline-complete": ["cline-complete", "idle", "waiting", false],
      "qa-running": ["codex-qa", "idle", "running", false],
      "qa-evidence-started": ["codex-qa", "idle", "running", false],
      "qa-evidence-finished": ["codex-qa", "idle", "running", false],
      "qa-fail": ["fail", "idle", "fail", false],
      "qa-retry": ["codex-qa", "idle", "running", false],
      "role-gate-failed": ["fail", "idle", "fail", false],
      retry: ["retry", "idle", "waiting", false],
      "qa-pass": ["pass", "idle", "pass", false],
      "manual-review": [recoveryClassification({output:event.qa,manualReviewCause:event.manualReviewCause})==='blocked'?'BLOCKED':'USER_ATTENTION', "idle", "fail", false],
      "user-attention": ["USER_ATTENTION", "idle", "fail", false],
      "blocked": ["BLOCKED", "idle", "fail", false],
      "task-set-aside": ["waiting", "idle", "waiting", false],
      "sol-reassessment-started": ["elevating", "idle", "fail", false],
      "sol-reassessment-finished": ["USER_ATTENTION", "idle", "fail", false],
      "resolver-started": ["resolving", "idle", "waiting", false],
      "resolver-finished": ["BLOCKED", "idle", "waiting", false],
      "resolver-error": ["BLOCKED", "idle", "fail", false],
      "codex-usage-limit": ["WAITING_FOR_CODEX", "idle", "waiting-for-codex", false],
      "waiting-for-codex": ["WAITING_FOR_CODEX", "idle", "waiting-for-codex", false],
      paused: ["paused", "idle", next.qaStatus, next.manualReview],
      stopped: ["stopped", "idle", next.qaStatus, next.manualReview],
    };
    if (event.type === "orchestrator-fallback") next.activeReasoningModel = event.model ?? null;
    const transition = transitions[event.type];
    if (transition) {
      [next.stage, next.clineStatus, next.qaStatus, next.manualReview] = transition;
    }
    if(['user-attention','manual-review'].includes(event.type)&&next.stage==='USER_ATTENTION') {next.userAttention=true;next.userAttentionReason=event.qa;next.userAttentionSince??=new Date().toISOString();}
    if(event.type==='blocked') {next.userAttention=false;next.blockedReason=event.qa;next.elevateRunning=false;}
    if(event.type==='qa-retry') {next.blockedReason=null;next.resolverResult=null;}
    if(event.type==='task-set-aside') {next.blockedReason=null;next.resolverResult=null;next.userAttention=false;next.userAttentionReason=null;}
    if(event.type==='qa-pass') {next.userAttention=false;next.userAttentionReason=null;next.elevateResult=null;}
    if (event.type === "codex-usage-limit" || event.type === "waiting-for-codex") {
      if (event.operation === "assessment" || event.operation === 'correction-assessment') next.qaStatus = "waiting";
      next.interruptedOperation = event.operation ?? next.interruptedOperation;
      next.codexLimitMessage = event.message ?? next.codexLimitMessage;
      next.codexRetryAt = event.retryAt ?? next.codexRetryAt;
      if (event.operation === "elevate") {
        next.manualReview = false;
        next.elevateRunning = false;
      }
      if(event.operation==='resolver')next.resolverRunning=false;
      if (event.operation === "qa" && event.source === "manual-elevate") next.elevateRunning = false;
    } else if (event.type === "codex-finished" || event.type === "codex-qa-finished" || event.type === 'sol-reassessment-finished' || event.type==='resolver-finished' || event.type === "cline-started" || event.type === "implementation-limit-resumed") {
      next.interruptedOperation = null;
      next.codexLimitMessage = null;
      next.codexRetryAt = null;
    }
    this.live = next;
    await atomicWriteJson(this.livePath, next);
    const { codexOperation: _privateCompletion, recovery: _privateRecovery, ...activityEvent } = event;
    if(event.type!=='recovery-state')await this.appendEvent(activityEvent);
  }

  async configureRuntime({ contextTokens, timeoutSeconds, model, provider }) {
    this.live ??= await this.readLive();
    if (!this.live) return;
    this.live = {
      ...this.live,
      cline: { ...(this.live.cline ?? {}), contextTokens, timeoutSeconds, model, provider },
      updatedAt: new Date().toISOString(),
    };
    await atomicWriteJson(this.livePath, this.live);
  }

  async appendEvent(event) {
    await mkdir(this.stateDir, { recursive: true });
    const currentTaskId = (await this.readLive())?.task?.id;
    const entry = redactDeep({ timestamp: new Date().toISOString(), taskId: currentTaskId, ...event });
    await appendFile(this.activityPath, `${JSON.stringify(entry)}\n`);
    // The tamper-evident copy (about 1.5 ms per entry). A failure to write it is reported but never stops the run.
    await appendAction(this.stateDir, entry).catch((error) => diagnostic("ACTION_LOG_WRITE_FAILED", { message: error.message }));
  }

  async readLive() {
    const live=await readJson(this.livePath,null);
    return migrateRecoveryState(live);
  }

  async readControl() {
    return {
      pauseAfterCurrent: false,
      stopAfterSafePoint: false,
      resumeGeneration: 0,
      ...(await readJson(this.controlPath, {})),
    };
  }

  /** source names who asked (app, dashboard, cli, run-limit); it is kept in the action log. */
  setControl(action, { source, reason } = {}) {
    const previous=this.controlQueue??Promise.resolve();
    const request=previous.catch(()=>{}).then(()=>this.applyControl(action, source, reason));
    this.controlQueue=request;return request;
  }

  async applyControl(action, source, reason) {
    const current = await this.readControl();
    const next = { ...current };
    if (action === "pause") next.pauseAfterCurrent = true;
    else if (action === "resume") {
      next.pauseAfterCurrent = false;
      next.stopAfterSafePoint = false;
      next.resumeGeneration = Number(current.resumeGeneration ?? 0) + 1;
    } else if (action === "stop") next.stopAfterSafePoint = true;
    // Picked up by the loop at its next boundary (no worker running): the task is set aside, its work stashed.
    else if (action === "defer") { next.deferGeneration = Number(current.deferGeneration ?? 0) + 1; next.deferReason = String(reason ?? "Deferred").slice(0, 400); }
    // Elevation for the failing task, taken up by the running loop when the task is waiting on a correction.
    else if (action === "request-elevation") next.elevateGeneration = Number(current.elevateGeneration ?? 0) + 1;
    else if(action==='retry-qa') {
      let recovery=null;
      try{recovery=JSON.parse(await readFile(path.join(this.stateDir,'current-task.json'),'utf8'))?.automation?.recovery??null;}catch{}
      const availability=qaRetryAvailability(recovery);
      if(!availability.available)throw Error('Retry QA unavailable: '+availability.reason);
      next.qaRetryGeneration=Number(current.qaRetryGeneration??0)+1;
      next.stopAfterSafePoint=false;
    }
    else if(action==='resolve') {
      const live=await this.readLive(),input=await loadResolverCase(this.stateDir);
      const availability=resolverAvailability({live,input});
      if(!availability.available||live.resolverRequested)throw Error('Resolver unavailable: '+(availability.reason??'already requested'));
      next.resolveGeneration=Number(current.resolveGeneration??0)+1;
      next.resolveFingerprint=input.fingerprint;
      this.live={...live,resolverRequested:true,updatedAt:new Date().toISOString()};await atomicWriteJson(this.livePath,this.live);
    }
    else if (action === "elevate") {
      const live = await this.readLive();
      const elevateCase = await loadElevateCase(this.stateDir);
      const availability = elevateAvailability({ live, fingerprint: elevateCase.fingerprint });
      if (!availability.available) throw new Error(`Elevate is not available: ${availability.reason}`);
      next.elevateGeneration = Number(current.elevateGeneration ?? 0) + 1;
      next.elevateFingerprint = elevateCase.fingerprint;
      this.live = {
        ...live,
        elevateRunning: true,
        elevateStartedAt: new Date().toISOString(),
        elevateUsedForFingerprint: elevateCase.fingerprint,
        elevateResult: null,
        updatedAt: new Date().toISOString(),
      };
      await atomicWriteJson(this.livePath, this.live);
    }
    else throw new Error(`Unknown control action: ${action}`);
    await atomicWriteJson(this.controlPath, next);
    if (action === "resume") {
      const live = await this.readLive();
      if (live?.stage === "paused") {
        this.live = {
          ...live,
          stage: live.qaStatus === "pass" ? "pass" : "waiting",
          updatedAt: new Date().toISOString(),
        };
        await atomicWriteJson(this.livePath, this.live);
      }
    }
    await this.appendEvent({ type: `control-${action}`, ...(source ? { source } : {}), ...(reason ? { reason } : {}) });
    return next;
  }

  async readEvents(limit = 50) {
    try {
      const lines = (await readFile(this.activityPath, "utf8")).trim().split(/\r?\n/).filter(Boolean);
      return lines.slice(-limit).map((line) => JSON.parse(line));
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }

  async clearActivityHistory() {
    const live = await this.readLive();
    const idleStage = ["USER_ATTENTION", "BLOCKED", "manual-review", "paused", "stopped", "WAITING_FOR_CODEX"].includes(live?.stage);
    const codexProcess = await readJson(path.join(this.stateDir, "codex-process.json"), null);
    if (!idleStage || live?.clineStatus === "running" || live?.qaStatus === "running" || live?.elevateRunning || codexProcess) {
      throw new Error("Activity history can only be cleared at an idle safe point");
    }
    await mkdir(this.stateDir, { recursive: true });
    const temporary = `${this.activityPath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, "");
    for (let attempt = 0;; attempt++) {
      try { await rename(temporary, this.activityPath); break; }
      catch (error) {
        if (!["EPERM", "EACCES"].includes(error.code) || attempt === 49) throw error;
        await new Promise((resolve) => setTimeout(resolve, Math.min(25, 5 * (attempt + 1))));
      }
    }
  }
}
