import { spawn } from "node:child_process";
import {installProtection} from './guard/install-protection.mjs';
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { atomicWriteJson } from "./dashboard-state.mjs";
import { autoSkillCatalogText, managerHandoffSkill, taskSkillMode } from "./task-handoff-skill.mjs";
import { TUNING, readFilesText, taskScopeText, workerSizingText } from "./engine-tuning.mjs";
import { withoutSecrets } from "./secret-env.mjs";
import { codexAuthEnv } from "./codex-provider-env.mjs";
import { launchSpec } from "./cmd-line.mjs";
import { redactText } from "./redact.mjs";
import {codexSkillArgs} from './skill-isolation.mjs';
import { codexUsage, noteUsage } from "./run-budget.mjs";
import { codexRunArgs } from "./cli-run-settings.mjs";
import { CODEX_FAIL_CLOSED } from "./guard/reasons.mjs";
import { appendBounded, CODEX_CALL_TIMEOUT_MS, killProcessTree } from "./process-bounds.mjs";

/** Codex used a tool (patch, shell, MCP) according to its --json events. */
export function codexUsedTools(stdout) {
  return /"type"\s*:\s*"(?:file_change|command_execution|mcp_tool_call|patch_apply|exec_command)/.test(stdout);
}

// Live bindings: importers (node-loop, recovery-loop) read the active orchestrator's labels.
export let QA_MODEL = "gpt-6.1-sol";
export let ASSESSMENT_MODEL = "gpt-6.1-sol";
export let RESOLVER_MODEL = "gpt-6.1-sol";
export let ELEVATE_MODEL = "gpt-6-astra";
export let CODEX_REASONING = "medium";

// Per-role reasoning effort and Fast speed tier. Defaults keep every role at CODEX_REASONING, standard speed.
export const ROLE_EFFORT = { qa: "medium", assessment: "medium", resolver: "medium", elevate: "medium" };
export const ROLE_FAST = { qa: false, assessment: false, resolver: false, elevate: false };

export function useOrchestratorModels({ qa, assessment, resolver, elevate, reasoning }) {
  QA_MODEL = qa; ASSESSMENT_MODEL = assessment; RESOLVER_MODEL = resolver; ELEVATE_MODEL = elevate; CODEX_REASONING = reasoning;
  for (const role of Object.keys(ROLE_EFFORT)) ROLE_EFFORT[role] = reasoning;
}

/** Apply per-role overrides ({ qa: { model, effort, fast }, ... }) on top of the orchestrator defaults. */
export function useRoleOverrides(overrides = {}) {
  for (const [role, value] of Object.entries(overrides)) {
    if (!(role in ROLE_EFFORT) || !value) continue;
    if (value.model) {
      if (role === "qa") QA_MODEL = value.model;
      else if (role === "assessment") ASSESSMENT_MODEL = value.model;
      else if (role === "resolver") RESOLVER_MODEL = value.model;
      else ELEVATE_MODEL = value.model;
    }
    if (value.effort) ROLE_EFFORT[role] = value.effort;
    if (value.fast !== undefined) ROLE_FAST[role] = value.fast;
  }
}

export const roleModel = (role) => ({ qa: QA_MODEL, assessment: ASSESSMENT_MODEL, resolver: RESOLVER_MODEL, elevate: ELEVATE_MODEL })[role];

/** invoke() options for a role; `fast` is only present when enabled. */
export function roleOptions(role) {
  return { model: roleModel(role), reasoningEffort: ROLE_EFFORT[role], ...(ROLE_FAST[role] ? { fast: true } : {}) };
}

export const recoveryOutputSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    status: {type:'string', enum:['correction','strategy-revised','insufficient-evidence','blocked']},
    preserve: {type:'array',items:{type:'string'}}, rootProblem:{type:'string'},
    previousStrategyFailure:{type:'string'}, newStrategy:{type:'string'}, nextWorkerInstructions:{type:'string'},
    neededEvidence:{type:'array',items:{type:'string'}}, failureReason:{type:'string'},
  },
  required:['status','preserve','rootProblem','previousStrategyFailure','newStrategy','nextWorkerInstructions','neededEvidence','failureReason'],
};
export function parseRecoveryResult(text) {
  const value=JSON.parse(text), keys=Object.keys(recoveryOutputSchema.properties);
  if(!value || Array.isArray(value) || keys.some(k=>!Object.hasOwn(value,k)) || Object.keys(value).some(k=>!keys.includes(k))) throw new Error('Malformed recovery result');
  for(const key of keys) {
    const schema=recoveryOutputSchema.properties[key];
    if(schema.type==='array' ? !Array.isArray(value[key]) || value[key].some(x=>typeof x!=='string') : typeof value[key]!=='string') throw new Error('Malformed recovery result: '+key);
  }
  if(!recoveryOutputSchema.properties.status.enum.includes(value.status)) throw new Error('Malformed recovery status');
  if(['correction','strategy-revised'].includes(value.status) && !value.nextWorkerInstructions.trim()) throw new Error('Missing bounded instructions');
  return value;
}

const taskSchema = {
  type: "object", additionalProperties: false,
  properties: { id: { type: "string" }, name: { type: "string" }, prompt: { type: "string" }, qaCommand: { type: "string" }, allowedPaths: { type: "array", items: { type: "string" } }, planItems: { type: "array", items: { type: "string" } }, planItemIds: { type: "array", items: { type: "string" } } },
  required: ["id", "name", "prompt", "qaCommand", "allowedPaths", "planItems", "planItemIds"],
};
export const codexOutputSchema = {
  type: "object", additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["task", "done", "pass", "fail", "manual-review"] },
    task: { anyOf: [taskSchema, { type: "null" }] },
    output: { type: "string" }, correction: { type: "string" }, commit: { type: "string" },
    manualReviewCause: { type: ["string", "null"] },
  },
  required: ["status", "task", "output", "correction", "commit", "manualReviewCause"],
};

const issueProperties=Object.fromEntries(['title','subsystem','symptoms','cause','fix','verification','nextTime','avoid'].map(k=>[k,{type:'string'}]));
Object.assign(issueProperties,Object.fromEntries(['reusable','causeEstablished','fixImplemented'].map(k=>[k,{type:'boolean'}])));
export const qaOutputSchema={...codexOutputSchema,properties:{...codexOutputSchema.properties,
  verifiedIssue:{anyOf:[{type:'null'},{type:'object',additionalProperties:false,properties:issueProperties,required:Object.keys(issueProperties)}]}},required:[...codexOutputSchema.required,'verifiedIssue']};
export function parseQaResult(text){
  const value=JSON.parse(text);if(!Object.hasOwn(value,'verifiedIssue'))throw new Error('Missing verifiedIssue');
  const {verifiedIssue,...rest}=value;parseCodexResult(JSON.stringify(rest));
  if(verifiedIssue!==null){
    if(!verifiedIssue||Array.isArray(verifiedIssue)||Object.keys(verifiedIssue).some(k=>!Object.hasOwn(issueProperties,k)))throw new Error('Malformed verified issue');
    for(const [key,schema] of Object.entries(issueProperties))if(typeof verifiedIssue[key]!==schema.type)throw new Error('Malformed verified issue: '+key);
  }
  return value;
}

export function parseCodexResult(text) {
  const value = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Codex structured result: expected object");
  const properties = Object.keys(codexOutputSchema.properties);
  for (const key of properties) {
    if (!Object.hasOwn(value, key)) throw new Error(`Invalid Codex structured result: missing ${key}`);
  }
  for (const key of Object.keys(value)) {
    if (!properties.includes(key)) throw new Error(`Invalid Codex structured result: unexpected ${key}`);
  }
  if (!codexOutputSchema.properties.status.enum.includes(value.status)) throw new Error("Invalid Codex structured result: invalid status");
  for (const key of ["output", "correction", "commit"]) {
    if (typeof value[key] !== "string") throw new Error(`Invalid Codex structured result: ${key} must be a string`);
  }
  if (value.manualReviewCause !== null && typeof value.manualReviewCause !== "string") {
    throw new Error("Invalid Codex structured result: manualReviewCause must be a string or null");
  }
  if (value.task !== null) {
    if (!value.task || typeof value.task !== "object" || Array.isArray(value.task)) throw new Error("Invalid Codex structured result: task must be an object or null");
    // planItems arrived in 0.20.2; results saved by older versions (or written by hand) have none.
    if (!Object.hasOwn(value.task, "planItems")) value.task.planItems = [];
    // planItemIds (the Task board keys of those items) arrived after 0.36; earlier results have none.
    if (!Object.hasOwn(value.task, "planItemIds")) value.task.planItemIds = [];
    const taskKeys = Object.keys(taskSchema.properties);
    for (const key of taskKeys) if (!Object.hasOwn(value.task, key)) throw new Error(`Invalid Codex structured result: task missing ${key}`);
    for (const key of Object.keys(value.task)) if (!taskKeys.includes(key)) throw new Error(`Invalid Codex structured result: unexpected task.${key}`);
    if (!Array.isArray(value.task.planItems) || value.task.planItems.some((entry) => typeof entry !== "string")) throw new Error("Invalid Codex structured result: task.planItems must be a string array");
    if (!Array.isArray(value.task.planItemIds) || value.task.planItemIds.some((entry) => typeof entry !== "string")) throw new Error("Invalid Codex structured result: task.planItemIds must be a string array");
    for (const key of ["id", "name", "prompt", "qaCommand"]) if (typeof value.task[key] !== "string") throw new Error(`Invalid Codex structured result: task.${key} must be a string`);
    if (!Array.isArray(value.task.allowedPaths) || value.task.allowedPaths.some((entry) => typeof entry !== "string")) throw new Error("Invalid Codex structured result: task.allowedPaths must be a string array");
  }
  return value;
}

const limitText = /(?:usage\s+limit(?:\s+(?:reached|exceeded))?|hit\s+your\s+usage\s+limit|credits?\s+(?:exhausted|depleted)|(?:out\s+of|no)\s+credits?\s+(?:remaining|left)?|purchase\s+more\s+credits)/i;
const limitCodes = new Set(["usage_limit_reached", "usage_limit_exceeded", "credits_exhausted", "insufficient_quota"]);

function terminalFailure(event) {
  if (event?.type === "error") return { message: event.message, code: event.code };
  if (event?.type === "turn.failed") return {
    message: event.error?.message ?? event.message,
    code: event.error?.code ?? event.code,
  };
  return null;
}

function retryText(message) {
  return message.match(/\b(?:try\s+again|retry|resets?|reset)\s+(?:after|at|on|in)\s+[^.\r\n]+/i)?.[0] ?? null;
}

export function detectCodexUsageLimit(output) {
  let detected = null;
  for (const line of String(output ?? "").split(/\r?\n/)) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const failure = terminalFailure(event);
    if (!failure || typeof failure.message !== "string") continue;
    if (!limitText.test(failure.message) && !limitCodes.has(String(failure.code ?? "").toLowerCase())) continue;
    detected = { message: failure.message, retryAt: retryText(failure.message) };
  }
  return detected;
}

export class CodexUsageLimitError extends Error {
  constructor({ message, retryAt = null }) {
    super(message);
    this.name = "CodexUsageLimitError";
    this.code = "CODEX_USAGE_LIMIT";
    this.retryAt = retryAt;
  }
}

// Read-only roles kept mistaking their own sandbox for a broken environment: a test runner that
// cannot create its temp folder (EPERM) was reported as manual review and blocked the loop.
export const READ_ONLY_SANDBOX = "Your sandbox is read-only on purpose. Commands that write anything (test runners, builds, tools that create temp or cache folders) can fail here with EPERM, EACCES or similar permission errors. That limit applies to this sandbox only: the implementation worker and QA run with write access. Never treat it as a blocker or as a reason for manual-review or blocked. Base your decision on reading the code; QA runs the checks.";

export function buildQaPrompt(qaPacket) {
  return [
    "You are QA, performing one bounded independent acceptance operation. Use the QA packet first.",
    managerHandoffSkill("qa"),
    "Inspect task, acceptance criteria, baseline SHA, scoped diff, changed files, deterministic evidence and worker summary.",
    "Do not fix implementation, author correction tasks, launch workers, choose the next task, or perform strategy reassessment. Assessment owns corrections.",
    "Run additional narrowly relevant commands only if evidence is missing, conflicting, or inconclusive.",
    "The engine's qaEvidence is shared with the second-opinion reviewer and bound to this workspace content. Reuse its passing checks rather than running them again. Reused evidence has the same command output; it is never a new test run. Review roleReviews independently; another reviewer's pass is not acceptance by itself.",
    "Do not begin with broad repository discovery, old logs, Git history, unrelated files, or operating-system process inspection.",
    "Never convert BLOCKED, INCONCLUSIVE, TIMEOUT or NON-TERMINATING evidence to PASS without trustworthy new evidence.",
    "Return fail for recoverable implementation problems with exact findings and remaining acceptance criteria in output. Leave correction empty.",
    "Return manual-review for hard blockers only; specify manualReviewCause: out-of-scope, unexpected-head, malformed-state, unsafe-commit, missing-permissions, security-policy, or destructive-action.",
    "A failed worker exit, failed required check, missing trustworthy final result, HEAD change or scope violation cannot pass.",
    "Only when all required checks pass: git add only approved changed paths, commit exactly this task, and return pass with full commit hash and verification evidence.",
    "Commit with plain commands the protection policy accepts: git add <each changed path> then git commit -m \"<message>\" (optionally -q, or a second -m for a body); no other commit flags, and no $, backticks, % or backslashes in the message.",
    "No-commit instructions in the Cline task apply to the implementing Cline worker. QA owns acceptance and the single scoped commit under the user-approved workflow. A direct user prohibition on commits still overrides this workflow. If commit approval is rejected, stop and report the rejection; do not retry or bypass it.",
    "Never edit source, weaken tests or change git configuration. End commands, return JSON and exit completely.",
    "verifiedIssue must be null unless an independently established recurring tooling/environment cause has an implemented fix and passing relevant verification. Only then supply a compact reusable issue entry. Never record speculative causes or ordinary application bugs.",
    "INPUT: " + JSON.stringify(qaPacket),
  ].join("\n");
}

export class CodexWorker {
  constructor({
    workspace, stateDir, command = "codex", prefixArgs = [], launcher, additionalWritableDirs = [], windowsSandbox, roleOverrides = {},
    spawnProcess = spawn, env = process.env, callTimeoutMs = CODEX_CALL_TIMEOUT_MS,
    writeProcessState = atomicWriteJson,
    clearProcessState = (file) => rm(file, { force: true }),
    isProcessAlive = async (pid) => {
      try { process.kill(pid, 0); return true; }
      catch (error) { if (error.code === "ESRCH") return false; throw error; }
    },
  }) {
    this.workspace = workspace;
    this.env = env;
    this.roleOverrides = roleOverrides;
    this.stateDir = stateDir;
    this.command = launcher?.command ?? command;
    this.prefixArgs = launcher?.prefixArgs ?? prefixArgs;
    this.additionalWritableDirs = additionalWritableDirs;
    if (windowsSandbox && !["elevated", "unelevated"].includes(windowsSandbox)) throw new Error("Invalid Windows sandbox mode");
    this.windowsSandbox = windowsSandbox;
    this.activeCount = 0;
    this.pidFile = path.join(stateDir, "codex-process.json");
    this.spawnProcess = spawnProcess;
    this.writeProcessState = writeProcessState;
    this.clearProcessState = clearProcessState;
    this.isProcessAlive = isProcessAlive;
    this.callTimeoutMs = callTimeoutMs;
  }

  async assertIdle() {
    if (this.activeCount) throw new Error("Codex child still active");
    let record;
    try { record = JSON.parse(await readFile(this.pidFile, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    if (!Number.isInteger(record?.pid) || record.pid <= 0) throw new Error("Cannot reconcile persisted Codex process state: invalid PID");
    let alive;
    try { alive = await this.isProcessAlive(record.pid, record); }
    catch (error) { throw new Error(`Cannot reconcile persisted Codex process state: ${error.message}`); }
    if (alive) throw new Error("Previous Codex child still alive (PID " + record.pid + "); manual review required");
    await this.clearProcessState(this.pidFile);
  }

  async invoke(prompt, sandbox = "read-only", { model, reasoningEffort, fast = false, schema = codexOutputSchema, parse = parseCodexResult } = {}) {
    // First: the active provider's key is registered as a secret before the prompt is redacted and written.
    const keep = codexAuthEnv({ env: this.env });
    prompt = redactText(prompt, { assignments: false });
    await this.assertIdle();
    const invocation = path.join(this.stateDir, "codex", randomUUID());
    await mkdir(invocation, { recursive: true });
    const outputFile = path.join(invocation, "result.json");
    const schemaFile = path.join(invocation, "schema.json");
    await writeFile(schemaFile, JSON.stringify(schema));
    await writeFile(path.join(invocation, "prompt.txt"), prompt);
    const extraWritableArgs = sandbox === "workspace-write"
      ? this.additionalWritableDirs.flatMap((directory) => ["--add-dir", directory])
      : [];
    const modelArgs = [
      ...(this.windowsSandbox ? ["-c", `windows.sandbox=${JSON.stringify(this.windowsSandbox)}`] : []),
      ...(model ? ["-m", model] : []),
      ...(reasoningEffort ? ["-c", `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`] : []),
      // Codex's Fast speed tier (model/list serviceTiers id "priority"); omitted keeps the user's config.
      ...(fast ? ["-c", `service_tier="priority"`] : []),
      // Per-run settings from CLIs › Codex › Settings (cli-run-settings.mjs: none loosens the sandbox).
      ...codexRunArgs(),
    ];
    // Read-only and workspace-write calls get Agent Dock's probed permissions profile (or the plain sandbox, stage 2).
    const codexMode = sandbox === "workspace-write" ? "write" : sandbox === "read-only" ? "read" : null;
    const protectionArgs=await installProtection({cli:'codex',workspace:this.workspace,stateDir:this.stateDir,invocation,allowGitCommit:sandbox==='workspace-write',
      codexMode,launcher:{command:this.command,prefixArgs:this.prefixArgs,env:withoutSecrets(this.env,{keep})},
      codexExtraArgs:this.windowsSandbox?["-c",`windows.sandbox=${JSON.stringify(this.windowsSandbox)}`]:[],writableDirs:sandbox==="workspace-write"?this.additionalWritableDirs:[]});
    const args = [...this.prefixArgs, "exec", "--ephemeral", "--json", "--color", "never", ...modelArgs, ...extraWritableArgs, ...protectionArgs,
      ...codexSkillArgs({workspace:this.workspace, env:this.env}),
      ...(codexMode ? [] : ["--sandbox", sandbox]),
      "--cd", this.workspace, "--output-schema", schemaFile,
      "--output-last-message", outputFile, "-"];
    this.activeCount++;
    let stdoutOutput = "";
    let stderrOutput = "";
    let output = "";
    try {
      await new Promise((resolve, reject) => {
        const launch = launchSpec(this.command, args);
        const child = this.spawnProcess(launch.command, launch.args, { cwd: this.workspace, env: withoutSecrets(this.env, { keep }), windowsHide: true, stdio: ["pipe", "pipe", "pipe"], ...launch.options });
        let registered = false;
        let closed = false;
        let closeCode = 1;
        let registrationError = null;
        let finished = false;
        // A call that never ends (a hung CLI, a check that never exits) is ended with its process tree.
        let timedOut = false;
        const deadline = setTimeout(() => { timedOut = true; killProcessTree(child); }, this.callTimeoutMs);
        child.stdout.on("data", (chunk) => { stdoutOutput = appendBounded(stdoutOutput, chunk); });
        child.stderr.on("data", (chunk) => { stderrOutput = appendBounded(stderrOutput, chunk); });
        child.stdin.on("error", () => {}); // Early CLI exit is reported by close.
        child.on("error", reject);
        const finishClosed = async () => {
          if (finished || !closed || (!registered && !registrationError)) return;
          finished = true;
          clearTimeout(deadline);
          try {
            if (timedOut) {
              if (registered) await this.clearProcessState(this.pidFile);
              reject(new Error(`Codex did not finish within ${Math.round(this.callTimeoutMs / 60_000) || "<1"} minutes and was ended.`));
              return;
            }
            if (registered) await this.clearProcessState(this.pidFile);
            if (registrationError) {
              reject(new Error(`Failed to register Codex process: ${registrationError.message}`));
              return;
            }
            output = [stdoutOutput, stderrOutput].filter(Boolean).join("\n");
            const usageLimit = detectCodexUsageLimit(output);
            if (usageLimit) reject(new CodexUsageLimitError(usageLimit));
            else if (closeCode === 0) resolve();
            else reject(new Error("Codex exited with code " + closeCode + ": " + output.slice(-4000)));
          } catch (error) { reject(error); }
        };
        // Never resolve on JSON output, final-message events, or even 'exit':
        // 'close' means the process has exited AND its stdio handles are closed.
        child.on("close", (code) => {
          closed = true;
          closeCode = code ?? 1;
          void finishClosed();
        });
        void (async () => {
          try {
            if (!Number.isInteger(child.pid) || child.pid <= 0) throw new Error("spawned child has no PID");
            await this.writeProcessState(this.pidFile, {
              pid: child.pid,
              startedAt: new Date().toISOString(),
              command: this.command,
            });
            registered = true;
            if (!closed) child.stdin.end(prompt);
          } catch (error) {
            registrationError = error;
            child.stdin.destroy();
            if (!closed) child.kill();
          }
          void finishClosed();
        })();
      });
    } finally {
      this.activeCount--;
      output ||= [stdoutOutput, stderrOutput].filter(Boolean).join("\n");
      await writeFile(path.join(invocation, "events.ndjson"), output);
      noteUsage(codexUsage(stdoutOutput), model);
    }
    // Fail closed, as implementation does: tool use without a single hook decision means the protection hook did not run.
    const decisions = (await readFile(path.join(invocation, "scope-hook.ndjson"), "utf8").catch(() => "")).trim();
    if (codexUsedTools(stdoutOutput) && !decisions) throw new Error(CODEX_FAIL_CLOSED);
    return parse(await readFile(outputFile, "utf8"));
  }

  optionsForRole(role) {
    const override = this.roleOverrides?.[role];
    if (!override) return roleOptions(role);
    return { model: override.model, reasoningEffort: override.effort ?? "medium", ...(override.fast ? { fast: true } : {}) };
  }

  // A task prompt missing its "Task skill:" line is sent back to Assessment once with the reason; a second miss still blocks.
  async assess(input) {
    const first = await this.assessOnce(input);
    if (first.status !== "task" || /^Task skill:/im.test(String(first.task?.prompt ?? ""))) return this.withTaskSkill(first);
    return this.withTaskSkill(await this.assessOnce(input, 'Your previous answer was rejected: the task prompt must contain a line "Task skill: diagnose", "Task skill: implement" or "Task skill: verify" as the bounded-task-handoff skill requires. Return the task again with that line.'));
  }

  withTaskSkill(result) {
    if (result.status === "task") taskSkillMode(result.task, "", { required: true });
    return result;
  }

  async assessOnce({ objective, previous }, retryNote = "") {
    const result = await this.invoke([
      "You are Assessment, performing one assessment operation. Inspect this repository and its instructions.",
      managerHandoffSkill("assessment") + autoSkillCatalogText(),
      taskScopeText(),
      workerSizingText() + ". State CREATE or MODIFY for every file and never ask it to verify that a CREATE file exists. Write into the prompt the exact exported signatures and types, the exact import lines with relative paths correct from the target file, and a minimal skeleton or fixture builder for new tests. " + readFilesText() + " Give one qaCommand that runs only this task's test plus typecheck if needed.",
      "Return status task with exact allowedPaths, a relevant executable qaCommand, and acceptance criteria in prompt.",
      "planItems: the unchecked IMPLEMENTATION_PLAN.md items that will be finished once this task is approved, counting work already committed (for example, a tests task that completes an item whose code an earlier task added, or an item the repository already fully satisfies). Copy each item's text exactly, without the leading \"- [ ] \"; use [] when none. Do not add the plan file to allowedPaths for this: after QA approves the task, the engine checks these items off itself.",
      "planItemIds: when the objective lists a Task priority, the bracketed id of each item in planItems, in the same order; otherwise [].",
      "qaCommand must use an existing project npm test/run script, or a supported local check (npx tsc, eslint, prettier, vitest or playwright), optionally chained with &&. No arbitrary executables, package installation, interpreters, shell expressions or output redirection. Protected paths cannot be inspected or edited; narrow file searches to public source directories and use git ls-files for discovery.",
      "Before returning a task, verify that allowedPaths are sufficient for every implementation change reasonably required to make qaCommand pass. Do not create a task whose required contract change predictably breaks typed fixtures or callers that the task forbids Cline to update.",
      "If required validation reveals or predictably requires changes outside allowedPaths, return manual-review instead of creating an impossible task or expecting Cline to cross the scope boundary.",
      "Do not weaken tests or use type assertions such as any to evade a contract mismatch; include the genuinely affected fixtures in allowedPaths or choose a smaller coherent task.",
      "The task prompt is addressed to Cline, which may only implement. Do not include staging, committing, acceptance, or next-task creation as Cline requirements. Codex QA alone owns acceptance and commits after implementation exits.",
      READ_ONLY_SANDBOX,
      "If the objective is complete return done. If blocked or scope unclear return manual-review with an explanation.",
      "Do not launch Cline, another Codex, background processes, or wait for development. Return JSON and exit.",
      "User objective: " + objective,
      "Previous completed task: " + JSON.stringify(previous ?? null),
      ...(retryNote ? [retryNote] : []),
    ].join("\n"), "read-only", this.optionsForRole("assessment"));
    return result;
  }

  review(qaPacket, context = {}) {
    return this.invoke(buildQaPrompt(qaPacket, context), "workspace-write", { ...this.optionsForRole("qa"), schema:qaOutputSchema, parse:parseQaResult });
  }

  assessCorrection(input) { return this.recoveryOperation(input, false); }

  reassessManualReview(input) { return this.recoveryOperation(input, true); }

  resolveBlocked(input) {
    return this.invoke([
      'You are Resolver. Analyze one blocked task and recommend a bounded recovery.',
      managerHandoffSkill("resolver"),
      'Read only INPUT. Do not edit files, delete/move files, commit, change HEAD, grant permissions, launch workers or expand allowedPaths.',
      READ_ONLY_SANDBOX,
      'Only Node may preserve verified current-run scratch files outside the repository. Unknown/pre-existing/modified/tracked files and Git/state/security/permission failures remain blocked.',
      'For an operational Cline editing-guard rejection with unchanged HEAD and no unexpected paths, recommend one materially different bounded tool strategy using workerCapabilities. Never authorize the rejected command, relax guards or expand scope. Supply exact allowed alternatives and preserve all prior QA findings. Assessment drafts the correction; QA still independently accepts it.',
      'For scope failures, return correction only when verifiedScratch and headMatches support safe preservation. Otherwise diagnose the block without claiming it solved. Review previousResolverStrategies: do not repeat them. At most '+TUNING.resolverMaxStrategies+' different recovery strategies may be applied.',
      'For unsafe or unresolved conditions return blocked or insufficient-evidence, with the exact needed manual action. Never call a scope violation QA PASS.',
      'Give concise nextWorkerInstructions, including direct edits and no repository scratch/helper files. Preserve correct existing work. Return JSON and exit completely.',
      'workerCapabilities.nativeTools is the observed runtime tool list, not a wish list. An empty list is unverified. Do not prescribe absent tools. Inspect editFailures for actual failed inputs/results and current source excerpts. When the tool guard is active (workerCapabilities present), require fresh reads, unique small matches and at most 2000 characters per editor field. A broken file this task created may be overwritten completely instead of patched. Verify helper/property paths in the supplied source evidence; do not invent them.',
      'INPUT: '+JSON.stringify(input),
    ].join('\n'),'read-only',{...this.optionsForRole("resolver"),schema:recoveryOutputSchema,parse:parseRecoveryResult});
  }

  recoveryOperation(input, elevation) {
    return this.invoke([
      elevation ? "You are Elevation. Reassess the strategy, not merely the next symptom." : "You are Assessment. Analyze this recoverable failure and prepare one bounded correction.",
      managerHandoffSkill(elevation ? "elevate" : "assessment"),
      "Read only INPUT. Preserve correct work, original task, baseline and scope. Do not edit code, commit, launch workers or choose another task.",
      READ_ONLY_SANDBOX,
      "Analyze what is correct, incorrect, incomplete, remaining criteria, why previous strategies failed, and what must be preserved.",
      "Use only tools in workerCapabilities.nativeTools when supplied; an empty list means availability is unverified. Inspect workerCapabilities.editFailures for exact failed inputs/errors. Do not assume apply_patch exists for GLM. Use one small edit, freshly read unique context, at most 2000 characters per editor field; never rewrite a pre-existing (git-tracked) file wholesale or reconstruct escaped literals. Exception: a file this task created (untracked, shown as CREATED BY THIS TASK in the worker prompt) that is structurally broken should be overwritten completely with its full corrected content, not patched piecemeal; keep that file small enough to write in one step. Verify property paths against actual code evidence. Do not request shell source-writing, helper files, redirection, unsupported tools or PowerShell pipelines. Resolver recommendations are advisory and never permission to weaken the guard.",
      "Make nextWorkerInstructions concise (target at most 1200 characters): give one concrete next change, its exact file/symbol, and the required test. Do not repeat the full task, old findings, correction history, or skill text. Preserve the original acceptance criteria; completing one change does not complete any remaining criteria.",
      elevation ? "Return strategy-revised with one materially revised strategy and bounded nextWorkerInstructions." : "Return correction with exact nextWorkerInstructions, preservation requirements and evidence-supported approach.",
      "If evidence is insufficient, return insufficient-evidence and specify the smallest executable diagnostic needed; do not invent a fix.",
      "Return blocked for unsafe Git/scope/state/permissions/security/destructive-action conditions. Never expand allowedPaths.",
      "Only relevant independently verified issue knowledge is supplied. Do not treat speculative prior reports as established causes.",
      "Return JSON and exit completely.",
      "INPUT: " + JSON.stringify(input),
    ].join("\n"), "read-only", {...this.optionsForRole(elevation?"elevate":"assessment"),schema:recoveryOutputSchema,parse:parseRecoveryResult});
  }
}
