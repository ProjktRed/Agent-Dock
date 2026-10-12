import { dashboardFields, dashboardView, dashboardEvents } from "./view-model.js";
import { createTaskDisclosure } from "./task-disclosure.js";
import {createPhaseProgress} from './phase-progress.js';

const $ = (selector) => document.querySelector(selector);
const set = (selector, value) => { const element = $(selector); if (element) element.textContent = value; };
const titleCase = (value) => String(value || "waiting").replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
const tone = (value) => {
  const text = String(value || "").toLowerCase();
  if (/pass|complete|running/.test(text)) return "success";
  if (/fail|blocked|stopped/.test(text)) return "danger";
  if (/attention|waiting for codex|paused|retry|inconclusive/.test(text)) return "warning";
  if (/not run|idle|waiting/.test(text)) return "waiting";
  return "active";
};
const eventLabels = {
  'resolver-started':'Resolver started', 'resolver-finished':'Resolver finished',
  'resolver-result':'Resolver result', 'resolver-error':'Resolver blocked',
  "task-loaded": "Task loaded", "codex-assessing": "Codex assessing next task", "codex-finished": "Codex assessment finished",
  "cline-started": "Cline started", "cline-process-started": "Cline process started", "cline-running": "Cline implementing",
  "cline-finished": "Cline finished", "qa-evidence-started": "Deterministic QA started", "qa-evidence-finished": "Deterministic QA finished",
  "codex-qa-started": "Codex QA started", "codex-qa-finished": "Codex QA finished", "qa-running": "Codex QA running", "qa-pass": "QA passed", "qa-fail": "QA failed",
  retry: "Correction attempt queued", paused: "Automation paused", stopped: "Automation stopped", "manual-review": "User Attention", 'user-attention':'User Attention', blocked:'Blocked',
  "codex-usage-limit": "Codex usage limit reached", "waiting-for-codex": "Waiting for Codex availability",
  "sol-reassessment-started": "Elevate reassessment started", "sol-reassessment-finished": "Elevate reassessment finished", "elevate-result": "Elevate result",
  "control-pause": "Pause requested", "control-resume": "Resume requested", "control-stop": "Stop requested",
};

let allEvents = [];
let expandedLogs = false;
const taskDisclosure = createTaskDisclosure();
const phaseProgress=createPhaseProgress($('#phase-progress'),document);

function renderTaskDisclosure() {
  const expanded = taskDisclosure.expanded;
  $("#task-card").classList.toggle("collapsed", !expanded);
  $("#toggle-task-card").textContent = expanded ? "Collapse Details" : "Expand Details";
  $("#toggle-task-card").setAttribute("aria-expanded", String(expanded));
}

function renderAcceptance(task) {
  const values = Array.isArray(task?.acceptanceCriteria) && task.acceptanceCriteria.length
    ? task.acceptanceCriteria
    : task?.instructions ? [task.instructions] : ["—"];
  $("#task-acceptance").replaceChildren(...values.map((value) => {
    const item = document.createElement("li"); item.textContent = value; return item;
  }));
}

function eventCategory(event) {
  if (event.type.startsWith("cline")) return "cline";
  if (event.type.includes("codex") || event.type.startsWith("qa-")) return "codex";
  return "system";
}

function eventText(event) {
  const detail = event.message || event.qa || event.path || (event.commands || []).join(", ") || event.retryAt;
  return `${eventLabels[event.type] || titleCase(event.type)}${detail ? ` — ${detail}` : ""}`;
}

function eventItems(events, includeTask = false) {
  return events.slice().reverse().map((event) => {
    const item = document.createElement("li"); item.dataset.category = eventCategory(event);
    const time = document.createElement("time"); time.textContent = event.timestamp ? new Date(event.timestamp).toLocaleTimeString([], { hour12: false }) : "—";
    const icon = document.createElement("i"); icon.className = `event-dot ${tone(event.type)}`;
    const text = document.createElement("span"); text.textContent = `${includeTask ? `[${eventCategory(event).toUpperCase()}] ${event.taskId ? `[${event.taskId}] ` : ""}` : ""}${eventText(event)}`;
    item.append(time, icon, text); return item;
  });
}

function renderEvents() {
  const filter = $("#activity-filter").value;
  const events = dashboardEvents(allEvents);
  const visible = filter === "all" ? events : events.filter((event) => eventCategory(event) === filter);
  $("#activity").replaceChildren(...eventItems(visible, true));
  $("#recent-events").replaceChildren(...eventItems(events.filter((event) => eventCategory(event) === "cline").slice(-12)));
  if (!$("#recent-events").children.length) { const item = document.createElement("li"); item.className = "empty"; item.textContent = "No Cline events yet."; $("#recent-events").append(item); }
}

function renderFiles(files) {
  const list = $("#changed-files");
  list.replaceChildren(...files.map((file) => {
    const item = document.createElement("li");
    const status = document.createElement("b"); status.className = `git-status ${tone(file.status === "D" ? "fail" : file.status === "??" ? "active" : "pass")}`; status.textContent = file.status.trim() || "M";
    const filePath = document.createElement("span"); filePath.textContent = file.path; const added = document.createElement("span"); added.className = "file-added"; added.textContent = Number.isFinite(file.additions) ? "+" + file.additions : "—";
    const removed = document.createElement("span"); removed.className = "file-removed"; removed.textContent = Number.isFinite(file.deletions) ? "−" + file.deletions : "—";
    item.append(status, filePath, added, removed); return item;
  }));
  if (!files.length) { const item = document.createElement("li"); item.className = "empty"; item.textContent = "No changed files"; list.append(item); }
}

function renderCommands(status, checks) {
  const commands = [...new Set((status.events || []).flatMap((event) => event.commands || []))];
  const commandState = (command) => /typecheck|\btsc\b/i.test(command) ? checks.typecheck : /lint/i.test(command) ? checks.lint : /build/i.test(command) ? checks.build : /test/i.test(command) ? checks.tests : "INCONCLUSIVE";
  const rows = commands.map((command) => ({ command, state: commandState(command) }));
  if (!rows.length) rows.push({ command: "No QA command recorded", state: "NOT RUN" });
  $("#command-results").replaceChildren(...rows.map((row) => {
    const item = document.createElement("li"); const icon = document.createElement("i"); icon.className = `event-dot ${tone(row.state)}`;
    const command = document.createElement("code"); command.textContent = row.command; const result = document.createElement("span"); result.className = `state-text ${tone(row.state)}`; result.textContent = row.state;
    item.append(icon, command, result); return item;
  }));
}

function render(status) {
  const view = dashboardView(status); const fields = dashboardFields(status); allEvents = status.events || [];
  phaseProgress.render(status.implementationProgress);
  set('#assessment-status',status.assessmentRunning?'Running':'Not Running');
  set('#elevation-status-pill',status.elevateRunning?'Running':'Not Running');
  const resolverElapsed=status.resolverRunning&&status.resolverStartedAt?Math.max(0,Math.floor((Date.now()-new Date(status.resolverStartedAt).getTime())/1000)):null;
  set('#resolver-state',status.resolverRunning?`Resolving · ${resolverElapsed??'—'}s`:status.resolverRequested?'Queued':status.resolverResult?.status||'Idle');
  set('#resolver-result',view.resolver.result);
  const resolve=$('#resolve-control');resolve.classList.toggle('hidden',!['BLOCKED','resolving'].includes(status.stage)&&!status.resolverRequested);resolve.disabled=!status.resolverAvailable||status.resolverRequested||view.resolver.running;resolve.textContent=view.resolver.running?'◇ Resolving…':'◇ Resolve Block';resolve.title=status.resolverUnavailableReason||'One bounded Resolver review';
  set("#phase-label", view.phase); set("#phase-name", status.task?.systemName || "Automation workflow");
  set("#task-id", view.task.id); set("#task-name", view.task.title); set("#task-description", view.task.description); set("#task-phase", view.phase); set("#task-priority", view.task.priority); set("#attempt", view.attempt); set("#task-state", view.primaryLabel);
  $("#task-state").className = tone(view.primaryLabel);
  renderAcceptance(status.task); taskDisclosure.onPoll(status); renderTaskDisclosure();
  set("#task-started", view.task.started ? new Date(view.task.started).toLocaleString() : "—"); set("#baseline-sha", view.task.baselineSha); set("#current-sha", view.task.currentSha); set("#stage", titleCase(status.stage));
  const primary = $("#primary-status"); primary.textContent = `○ ${view.primaryLabel}`; primary.className = `badge ${tone(view.primaryLabel)}`;
  $("#sidebar-dot").className = `dot ${tone(view.primaryLabel)}`; set("#automation-status", `System ${view.primaryLabel}`);
  document.querySelectorAll("[data-step]").forEach((element) => { const active = element.dataset.step === view.activeStep; element.classList.toggle("active", active); element.toggleAttribute("aria-current", active); });
  set("#cline-started", fields.clineStarted); set("#cline-elapsed", fields.clineElapsed); set("#cline-pid", fields.clinePid); set("#activity-elapsed", fields.clineElapsed); set("#cline-model", status.cline?.model ? `Model: ${status.cline.model}` : "Model: —"); set("#task-model", status.cline?.model ? `Model: ${status.cline.model}` : "Model: —");
  const clineLabel = titleCase(status.clineStatus || "idle"); set("#cline-state-pill", clineLabel); $("#cline-state-pill").className = `pill ${tone(clineLabel)}`;
  const qaLabel = status.stage === "WAITING_FOR_CODEX" && status.interruptedOperation === "qa" ? "Waiting for Codex" : titleCase(status.qaStatus || "waiting"); set("#qa-state-pill", qaLabel); $("#qa-state-pill").className = `pill ${tone(qaLabel)}`;
  for (const [key, id] of Object.entries({ tests: "qa-tests", typecheck: "qa-typecheck", lint: "qa-lint", scopeCheck: "qa-scope" })) { const element = $("#" + id); element.textContent = view.qaChecks[key]; element.className = `state-text ${tone(view.qaChecks[key])}`; }
  set("#progress-label", view.progress.label); set("#progress-symbol", view.activeStep === "complete" ? "✓" : view.activeStep === "qa" ? "◉" : "↻");
  set("#current-action", view.activity.currentAction); set("#last-command", view.activity.lastCommand); set("#last-file-read", view.activity.lastFileRead); set("#last-file-modified", view.activity.lastFileModified); set("#latest-message", view.activity.latestMessage);
  set("#changed-count", String(view.changedFiles.length)); renderFiles(view.changedFiles); renderCommands(status, view.qaChecks); renderEvents();
  document.querySelectorAll(".workspace").forEach((element) => element.textContent = status.workspace || "—");
  set("#max-attempts", status.maxAttempts == null ? "Unlimited" : String(status.maxAttempts)); set("#cline-context", fields.clineContext); set("#cline-timeout", fields.clineTimeout); set("#task-prompt", status.task?.prompt || "No task loaded."); set("#qa-result", status.latestQa || "N/A");
  const blocked=status.stage==='BLOCKED',attention=Boolean(status.userAttention);
  $("#manual-review").className=`notice ${blocked?'danger':'warning'} ${blocked||attention?'':'hidden'}`;
  set('#attention-label',blocked?'Blocked':'User Attention');
  set('#manual-review-reason',blocked?(status.blockedReason||status.latestQa):`${status.userAttentionReason||status.latestQa||''} Development continues automatically. Pause if you want to inspect the issue.`);
  $('#recovery-panel').classList.toggle('hidden',!attention&&!status.activeReasoningRole&&!status.elevateResult);
  set('#reasoning-role',status.activeReasoningRole?`${status.activeReasoningRole} · ${status.activeReasoningModel||'—'} · Medium`:status.clineStatus==='running'?'Implementing · '+(status.cline?.model||'—'):'Idle');
  set('#recovery-summary',`Assessment corrections attempted: ${view.recovery.correctionCount}. Automatic elevation after 3 further failed Assessment corrections.`);
  set('#known-issues',`Verified issue guidance: ${(status.knownIssues||[]).join('; ')||'No relevant entries selected'}`);
  $('#elevation-result').classList.toggle('hidden',!status.elevateResult);
  const er=status.elevateResult;
  set('#elevation-result-text',er?`${er.model||'gpt-6-astra'} · Medium\n${er.label||er.kind}\nRoot problem: ${er.rootProblem||er.reason||'—'}\nPreserve: ${(er.preserve||[]).join('; ')||'—'}\nNew strategy: ${er.newStrategy||'—'}\nNext: ${er.nextWorkerInstructions||(er.neededEvidence||[]).join('; ')||'—'}`:'');
  const limited = status.stage === "WAITING_FOR_CODEX"; $("#codex-limit").classList.toggle("hidden", !limited); set("#codex-limit-stage", titleCase(status.interruptedOperation || "operation")); set("#codex-limit-message", status.codexLimitMessage || "Codex usage limit reached."); set("#codex-reset", status.codexRetryAt || "");
  const elevate = $("#elevate-control");
  const showElevate = (attention||status.elevateRunning) && !blocked && Boolean(status.task) && Boolean(status.latestQa);
  elevate.classList.toggle("hidden", !showElevate);
  elevate.disabled = !status.elevateAvailable || Boolean(status.elevateRunning);
  elevate.textContent = status.elevateRunning ? "◆ Elevating…" : "◆ Elevate";
  const elevateStatus = $("#elevate-status");
  const elapsed = status.elevateRunning && status.elevateStartedAt ? Math.max(0, Math.floor((Date.now() - new Date(status.elevateStartedAt).getTime()) / 1000)) : null;
  const elevateModel = status.elevateModel === "gpt-6-astra" ? "Astra Medium" : status.elevateModel || "Reassessment";
  const elevateText = status.elevateRunning ? `${elevateModel} · ${elapsed}s` : status.elevateResult?.label || "";
  set('#elevation-progress',status.elevateRunning?`ELEVATING · ${elevateModel} · ${status.elevateAutomatic?'Automatic':'Manual'} · ${elapsed}s · ${status.elevateTriggeredBy||''}`:'');
  elevateStatus.classList.toggle("hidden", !elevateText); elevateStatus.textContent = elevateText;
  set("#control-note", status.control?.stopAfterSafePoint ? "Stop requested — waiting for a safe boundary" : status.control?.pauseAfterCurrent ? "Pause requested — after the current task" : limited ? "Resume retries only the interrupted Codex operation" : "Automation will stop at safe boundaries only");
}

async function refresh() {
  try { const response = await fetch("/api/status", { cache: "no-store" }); if (!response.ok) throw new Error("Status unavailable"); render(await response.json()); set("#activity-live", "Live"); if (expandedLogs) { const logs = await fetch("/api/logs", { cache: "no-store" }); if (logs.ok) { allEvents = await logs.json(); renderEvents(); } } }
  catch { set("#primary-status", "○ Offline"); $("#primary-status").className = "badge danger"; set("#automation-status", "Connection unavailable"); set("#activity-live", "Offline"); }
}

document.querySelectorAll("button[data-action]").forEach((button) => button.addEventListener("click", async () => { button.disabled = true; try { const response = await fetch("/api/control", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: button.dataset.action }) }); if (!response.ok) throw new Error(); await refresh(); } catch { set("#control-note", "Control request failed. Please try again."); } finally { if (button.dataset.action !== "elevate") button.disabled = false; } }));
$("#toggle-task-card").addEventListener("click", () => { taskDisclosure.toggle(); renderTaskDisclosure(); });
$("#toggle-logs").addEventListener("click", async () => { expandedLogs = true; $("#activity-log").scrollIntoView({ block: "nearest" }); await refresh(); });
$("#view-all-events").addEventListener("click", () => $("#activity-log").scrollIntoView({ block: "nearest" }));
$("#toggle-details").addEventListener("click", () => { $("#details").classList.add("open"); $("#details").scrollIntoView({ block: "nearest" }); });
$("#view-task").addEventListener("click", () => { $("#details").classList.add("open"); $("#details").scrollIntoView({ block: "nearest" }); });
$("#close-details").addEventListener("click", () => $("#details").classList.remove("open"));
$("#activity-filter").addEventListener("change", renderEvents); $("#clear-log").addEventListener("click", async () => {
  const response = await fetch("/api/activity/clear", { method: "POST" }).catch(() => null);
  if (response?.ok) await refresh();
  else set("#control-note", "Activity can be cleared only at an idle safe point.");
});
const updateClock = () => set("#clock", new Date().toLocaleString([], { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" }));
updateClock(); await refresh(); setInterval(() => { updateClock(); refresh(); }, 1000);
