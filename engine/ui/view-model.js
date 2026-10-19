export function dashboardFields(status) {
  const startedAt = status.cline?.startedAt ? new Date(status.cline.startedAt) : null;
  const elapsedMs = status.cline?.elapsedMs ?? (startedAt && status.clineStatus === "running"
    ? Date.now() - startedAt.getTime()
    : status.cline?.durationMs);
  const elapsed = Number.isFinite(elapsedMs)
    ? `${Math.floor(elapsedMs / 60_000).toString().padStart(2, "0")}:${Math.floor((elapsedMs % 60_000) / 1000).toString().padStart(2, "0")}`
    : "—";
  const checks = status.qaChecks ?? {};
  return {
    clineStarted: startedAt ? startedAt.toLocaleTimeString([], { hour12: false }) : "—",
    clineElapsed: elapsed,
    clinePid: String(status.cline?.pid ?? "—"),
    clineContext: Number.isInteger(status.cline?.contextTokens) ? `${status.cline.contextTokens.toLocaleString("en-US")} tokens` : "—",
    clineTimeout: Number.isFinite(status.cline?.timeoutSeconds) ? `${Math.round(status.cline.timeoutSeconds / 60)} min` : "—",
    qaChecks: {
      tests: checks.tests ?? "NOT RUN",
      typecheck: checks.typecheck ?? "NOT RUN",
      lint: checks.lint ?? "NOT RUN",
      scopeCheck: checks.scopeCheck ?? "NOT RUN",
    },
  };
}

const explicitCheck = (value) => {
  const normalized = String(value ?? "NOT RUN").toUpperCase();
  return ["PASS", "FAIL", "RUNNING", "NOT RUN", "INCONCLUSIVE"].includes(normalized) ? normalized : "INCONCLUSIVE";
};

const lastEventWith = (events, predicate) => events.slice().reverse().find(predicate);

export function dashboardEvents(events = []) {
  // Display-only: leave persisted activity and the worker protocol untouched.
  return events.filter((event) => event.type !== "cline-compaction" && !(event.type === "cline-message"
    && /^auto-compact(?:ing|ed|ion-skipped)$/.test(String(event.message ?? event.action ?? "").trim())));
}

function workflowStep(status) {
  if (status.stage === "pass" || status.stage === "complete") return "complete";
  if (["qa", "fail", "manual-review"].includes(status.stage)) return "qa";
  if (status.stage === "WAITING_FOR_LIMIT" && status.interruptedOperation === "assessment") return "implement";
  if (status.stage === "WAITING_FOR_LIMIT") return "qa";
  return "implement";
}

function primaryLabel(status) {
  if(status.resolverRunning||status.stage==='resolving')return 'Resolving';
  if(status.stage==='BLOCKED')return 'Blocked';
  if (status.stage === "WAITING_FOR_LIMIT") return "Waiting for usage limit";
  if(status.elevateRunning || status.stage==='elevating')return 'Elevating';
  if(status.assessmentRunning)return 'Assessment';
  if(status.stage==='USER_ATTENTION'||status.manualReview||status.stage==='manual-review')return 'User Attention';
  if (status.stage === "paused") return "Paused";
  if (status.stage === "stopped") return "Stopped";
  if (status.stage === "retry") return "Retrying";
  if (status.stage === "pass" || status.stage === "complete") return "Complete";
  if (status.stage === "fail") return "Failed";
  if (status.clineStatus === "running" || status.qaStatus === "running" || ["current-task", "qa"].includes(status.stage)) return "Running";
  return "Waiting";
}

function currentAction(status, events = []) {
  const activity = lastEventWith(events, (event) => event.type?.startsWith("cline-") && (event.action || event.message));
  if(status.resolverRunning)return 'GPT-6.1 Sol resolving the blocked case';
  if(status.stage==='BLOCKED')return 'Blocked — user action required';
  if (status.stage === "WAITING_FOR_LIMIT") return `Waiting to resume ${status.interruptedOperation || "the operation"} after the usage limit`;
  if(status.elevateRunning)return 'GPT-6 Astra reassessing strategy';
  if(status.assessmentRunning)return 'GPT-6.1 Sol preparing a bounded task/correction';
  if(status.stage==='USER_ATTENTION')return 'Recoverable problem — development continues automatically';
  if (status.stage === "paused") return "Automation paused at a safe boundary";
  if (status.stage === "retry") return "Preparing the next Cline correction attempt";
  if (status.qaStatus === "running" || status.stage === "qa") return "QA is reviewing deterministic evidence";
  if (status.clineStatus === "running") return activity?.action || activity?.message || "Cline is implementing the current task";
  if (status.stage === "pass" || status.stage === "complete") return "Task completed";
  if (status.stage === "fail") return "QA found issues";
  if (activity) return activity.action || activity.message;
  return "No active work";
}

export function dashboardView(status = {}) {
  const events = dashboardEvents(Array.isArray(status.events) ? status.events : []);
  const checks = status.qaChecks ?? {};
  const commandEvent = lastEventWith(events, (event) => Array.isArray(event.commands) && event.commands.length);
  const readEvent = lastEventWith(events, (event) => event.type === "cline-file-read" && event.path);
  const modifiedEvent = lastEventWith(events, (event) => event.type === "cline-file-modified" && event.path);
  const messageEvent = lastEventWith(events, (event) => typeof event.message === "string" || typeof event.qa === "string");
  const task = status.task ?? {};
  const label = primaryLabel(status);
  const progressLabels = {
    implementing: "Implementation in progress", implemented: "Implementation finished",
    qa: "QA review in progress", pass: "Task complete", complete: "Phase complete",
    fail: "QA failed", retry: "Correction attempt", WAITING_FOR_LIMIT: "Waiting for usage limit",
    paused: "Paused", "manual-review": "User Attention", USER_ATTENTION:'User Attention', BLOCKED:'Blocked', elevating:'Elevating', stopped: "Stopped",
  };
  return {
    resolver:{available:Boolean(status.resolverAvailable),running:Boolean(status.resolverRunning),result:status.resolverResult?`${status.resolverResult.status}: ${status.resolverResult.failureReason||status.resolverResult.nextWorkerInstructions||'—'}`:''},
    recovery: {correctionCount:status.correctionCount??0,reason:status.userAttentionReason??'',result:status.elevateResult??null,
      role:status.activeReasoningRole??(status.clineStatus==='running'?'Implementing':null),model:status.activeReasoningModel??null},
    activeStep: workflowStep(status),
    primaryLabel: label,
    phase: task.phase ? `Phase ${task.phase}` : "Current task",
    attempt: Number.isInteger(status.attempt) && status.attempt > 0 ? `Attempt ${status.attempt}` : "Attempt N/A",
    task: {
      id: task.id || "—", title: task.name || "No active task",
      description: task.description || task.prompt || "N/A", priority: task.priority || "N/A",
      started: task.startedAt || status.cline?.startedAt || null,
      baselineSha: task.baselineSha || status.baselineSha || "—",
      currentSha: status.currentSha || "—",
    },
    qaChecks: {
      tests: explicitCheck(checks.tests), typecheck: explicitCheck(checks.typecheck),
      lint: explicitCheck(checks.lint), build: explicitCheck(checks.build), scopeCheck: explicitCheck(checks.scopeCheck),
    },
    progress: { label: progressLabels[status.stage] || label, percent: null },
    activity: {
      currentAction: currentAction(status, events),
      lastCommand: commandEvent?.commands.at(-1) || "N/A",
      lastFileRead: readEvent?.path || "N/A",
      lastFileModified: modifiedEvent?.path || "N/A",
      latestMessage: messageEvent?.message || messageEvent?.qa || status.latestQa || "N/A",
    },
    changedFiles: Array.isArray(status.changedFiles) ? status.changedFiles : [],
  };
}
