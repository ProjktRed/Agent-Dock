import "./lib/tool-lookup";
import os from "node:os";
import { runReportHtml, runReportMarkdown } from "./lib/run-export";
import { sanitizeTaskBoardUpdate } from "./lib/task-board";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { app, BrowserWindow, dialog, ipcMain, Menu, net, Notification, protocol, session, shell, Tray } from "electron";
import { pathToFileURL } from "node:url";
import { APP_SCHEME, appUrl, resolveAppPath } from "./lib/app-protocol";
import type { ControlAction, LaunchCheck, Notice } from "@shared/api";
import type { AddProjectRequest, Agent, CiStatus, CiWatch, CliConnection, CliHealth, EngineInfo, NotifyChannel, Project, ProjectStatus, Settings, SkillInfo, TokenRecord, UsageSummary } from "@shared/types";
import { defaultAgents } from "./defaults";
import { discoverClis, foundTools, runningLocal, systemProbes } from "./discovery";
import { EngineManager } from "./engine";
import { appIcon } from "./icon";
import { checkCli, detectOnPath, pickRunnable, whereAll } from "./lib/clis";
import { agentForRole, buildEngineArgs } from "./lib/engine-args";
import { isCompactionDone } from "./lib/usage";
import { RemoteApprovals, type ApprovalAction, type EmailChannel, type TelegramChannel } from "./lib/remote-approvals";
import { countCompactions, implementationUsage, readActivity, readOrchestratorUsage } from "./lib/usage";
import { dueScheduledStart, lastPassedSlot, missedScheduledStart, SCHEDULE_GRACE_MINUTES } from "@shared/schedule";
import { normalizeAppearance, STYLE_BACKGROUNDS, styleAccent } from "@shared/appearance";
import { SCHEDULED_RUN_FLAG, syncOsSchedules } from "./lib/os-schedule";
import { syncLinuxSchedules } from "./lib/linux-schedule";
import { ensureRunBranch, openPullRequest, pushRunBranch } from "./lib/pull-request";
import { isOpenRouter, openRouterKeyLimit } from "./lib/key-limit";
import { estimateRecord, ESTIMATES_FILE, ESTIMATES_KEPT, type EstimateRecord } from "@shared/estimate";
import { taskModeOf } from "@shared/task-mode";
import { cleanRunSettings, isRunSettingKind } from "@shared/cli-settings";
import { isCliKind, isConnectionId } from "@shared/defaults";
import { CI_FIX_MAX, CI_GIVE_UP_MS, CI_POLL_MS, ciFixNote, failedLogs, isFinal, readCi } from "./lib/ci-status";
import { addLaneWorktree, cleanParallelWorktrees, listParallelLeftovers, mergeLaneBranch, removeLaneWorktree } from "./lib/worktree";
import { addProject, canRerun, inspectDirectory, managedProjectFolder, prepareRerun, savedTaskIds, taskHistory } from "./projects";
import { AUTO_INDEX_MAX, listSkills, ROLE_SKILLS_MAX_CHARS, SKILL_MAX_CHARS, skillDeliveryText } from "./skills";
import { installLibraryImport, previewLibraryImport, TRUSTED_LIBRARIES } from "./skill-library";
import { generatePlan, PLANNER_KINDS, savePlan } from "./planner";
import { RolesService } from "./roles";
import { AppStore } from "./store";
import { ownerFixCommand, run, sharedGitOwnerProblem } from "./lib/git";
import { canOpenPath, isExternalWebUrl } from "./lib/safe-open";
import { interruptedWork, skipPoll } from "./lib/status";
import { STAGING, Updater } from "./updater";
import { collectDiagnostics } from "./diagnostics";
import { exportSettings, mergeImport, parseSettingsFile } from "./settings-transfer";
import { zipFiles } from "./lib/zip";
import { LimitsService } from "./limits";
import { ModelsService } from "./models";
import { collectLlamaCpp, collectOllama, detectLlamaModelsDir, readLocalContext } from "./local-models";
import {assertSafeLaunch,hardenSession,hardenWebContents} from './lib/security';
import { stopLauncher } from "./lib/stop-launcher";
import { sanitizeSettings, weakenings } from "./settings-validate";
import { rememberContent, restoreWatchedFiles, watchFolder } from "./lib/json-file";
import { engineFileProblems, MANIFEST_FILE } from "./lib/integrity";
import { readConfigFile, writeConfigFile } from "./lib/cli-config-files";
import { isLocalUrl, readOllamaSettings, writeOllamaSettings } from "./lib/ollama-settings";

try {
  assertSafeLaunch(app.isPackaged,[...process.argv,...process.execArgv,...['remote-debugging-port','remote-debugging-pipe','inspect','inspect-brk','inspect-port'].filter(flag=>app.commandLine.hasSwitch(flag)).map(flag=>'--'+flag)]);
} catch(error) {
  console.error((error as Error).message);
  app.exit(64);
}
app.on('web-contents-created',(_event,contents)=>hardenWebContents(contents));
// The renderer is served from app://agent-dock/ (lib/app-protocol.ts), never file://; registered before ready.
protocol.registerSchemesAsPrivileged([{ scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
app.on('session-created',created=>hardenSession(created));

// Portable copy: a portable.json beside AgentDock.exe keeps every setting, project and log in a
// data folder next to it (a flash drive carries the whole setup). Must run before anything reads userData.
const portable = (() => {
  if (!app.isPackaged) return null;
  const dir = path.dirname(process.execPath);
  const file = path.join(dir, "portable.json");
  if (!existsSync(file)) return null;
  let options: { updates?: boolean } = {};
  try {
    options = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    // an empty or invalid marker still means portable
  }
  return { dir, data: path.join(dir, "data"), updates: options.updates === true };
})();
if (portable) {
  app.setPath("userData", portable.data);
  app.setPath("crashDumps", path.join(portable.data, "crash-dumps"));
  app.setAppLogsPath(path.join(portable.data, "logs"));
}
// Development runs (npm run dev) keep their own settings, projects and secrets, apart from an
// installed copy's; --user-data-dir still picks any other folder.
if (!app.isPackaged && !app.commandLine.hasSwitch("user-data-dir")) app.setPath("userData", path.join(app.getPath("appData"), "Agent Dock Dev"));

if (!app.requestSingleInstanceLock()) app.quit();

// Shortcuts start the app with its install folder as the working directory, and every process it
// starts inherits that. One that outlives the app (a llama.cpp server, an orphaned CLI) then keeps
// the install folder in use and the next update cannot replace it. Work from the user data folder.
try {
  mkdirSync(app.getPath("userData"), { recursive: true });
  process.chdir(app.getPath("userData"));
} catch {
  // keep the inherited directory
}

const engineDir = app.isPackaged ? path.join(process.resourcesPath, "engine") : path.join(app.getAppPath(), "engine");
const store = new AppStore(app.getPath("userData"));
watchFolder(store.dir);
const stateRoot = path.join(app.getPath("userData"), "projects");
const rolesDir = path.join(app.getPath("userData"), "roles");
const roles = new RolesService(rolesDir);
let engineInfo: EngineInfo;
let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
const startHidden = process.argv.includes("--minimized");
const health = new Map<string, CliHealth>();
const lastStatus = new Map<string, ProjectStatus>();

async function resolveNode(): Promise<{ command: string; env: NodeJS.ProcessEnv }> {
  if (store.data.settings.advanced.nodeRuntime === "system") {
    const node = pickRunnable(await whereAll("node"));
    if (node) return { command: node, env: { ...process.env } };
  }
  // Fall back to Electron's bundled Node runtime.
  return { command: process.execPath, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } };
}

// Packaged builds compare the engine with the file list the build put in app.asar (src/main/lib/integrity.ts).
const engine = new EngineManager(engineDir, resolveNode, () => (app.isPackaged ? engineFileProblems(process.resourcesPath, path.join(__dirname, MANIFEST_FILE)) : []));
let updater: Updater;
let limits: LimitsService;
let models: ModelsService;

async function applyUpdate() {
  const running = store.data.projects.filter((p) => engine.isAlive(p.id));
  if (running.length) throw new Error(`Stop the automation first (${running.map((p) => p.name).join(", ")}). Updating replaces the engine files.`);
  await updater.apply(store.data.settings, (relaunch) => {
    quitting = true;
    if (relaunch) app.relaunch({ execPath: relaunch, args: [] });
    app.quit();
  });
}

async function checkForUpdatesOnLaunch() {
  if (updater.status.state === "portable") return;
  await updater.readLastSwap();
  if (updater.status.state === "error") {
    notice({ kind: "error", message: updater.status.error ?? "The last update failed." });
    return;
  }
  await checkForUpdates(false);
  scheduleUpdateChecks();
}

/** Background update listener: a cheap `git ls-remote` on a timer and when the window is focused. */
let updateTimer: NodeJS.Timeout | null = null;
let lastUpdateCheck = 0;
let updateCheckRunning = false;
const FOCUS_CHECK_MS = 10 * 60_000;

function scheduleUpdateChecks() {
  if (updateTimer) clearInterval(updateTimer);
  updateTimer = null;
  if (updater.status.state === "portable") return;
  const { autoCheck, checkMinutes } = store.data.settings.updates;
  if (autoCheck && checkMinutes > 0) updateTimer = setInterval(() => void checkForUpdates(true), checkMinutes * 60_000);
}

function checkOnFocus() {
  const { autoCheck, checkMinutes } = store.data.settings.updates;
  if (autoCheck && checkMinutes > 0 && Date.now() - lastUpdateCheck > FOCUS_CHECK_MS) void checkForUpdates(true);
}

async function checkForUpdates(quiet: boolean) {
  const { updates } = store.data.settings;
  if (!updates.autoCheck || updater.busy || updateCheckRunning) return;
  updateCheckRunning = true;
  lastUpdateCheck = Date.now();
  try {
    await reactToUpdateCheck(quiet);
  } finally {
    updateCheckRunning = false;
  }
}

async function reactToUpdateCheck(quiet: boolean) {
  const { updates } = store.data.settings;
  const knownCommit = updater.status.state === "available" ? updater.status.latest?.commit : null;
  const status = await updater.check(store.data.settings, { quiet }).catch(() => null);
  if (status?.state !== "available") return;
  // A background check only speaks up for a commit it has not announced yet.
  if (quiet && status.latest?.commit === knownCommit) return;
  const n = status.commits.length;
  const summary = `${n || "New"} commit${n === 1 ? "" : "s"} since ${status.installed?.shortCommit}: ${status.latest?.subject ?? ""}`;
  if (updates.autoInstall && !store.data.projects.some((p) => engine.isAlive(p.id))) {
    osNotify("Updating Agent Dock", summary);
    await applyUpdate().catch((e) => notice({ kind: "error", message: `Update failed: ${e.message}` }));
    return;
  }
  // Otherwise the renderer shows the in-app update notice in the title bar (UpdateNotice);
  // when the window is hidden or in the background, a Windows notification points to it.
  if (quiet && !win?.isFocused()) osNotify(`Agent Dock ${status.latest?.version ? `v${status.latest.version} ` : ""}is available`, summary);
}

const send = (channel: string, value: unknown) => win?.webContents.send(channel, value);
const notice = (n: Notice) => send("notice", n);
const project = (id: string) => {
  const p = store.data.projects.find((x) => x.id === id);
  if (!p) throw new Error("Project not found");
  return p;
};
const agents = () => store.data.agents ?? [];
const planners = new Map<string, AbortController>();

function osNotify(title: string, body: string) {
  if (Notification.isSupported()) new Notification({ title, body, icon: appIcon(64) }).show();
}

function launchCheck(p: Project): LaunchCheck {
  return buildEngineArgs({ project: p, agents: agents(), clis: store.data.clis.map((c) => ({ ...c, hasSecret: store.hasCliSecret(c.id) })), settings: store.data.settings, roles: roles.roles, protectedRoots: [store.dir, engineDir, ...(app.isPackaged ? [path.dirname(process.execPath)] : [])] });
}

/** Engine arguments for a start; writes the workflow roles the engine reads (--roles-file) into the project's state folder. */
async function launchArgs(p: Project, check = launchCheck(p)): Promise<string[]> {
  if (check.roles.length) {
    await mkdir(p.stateDir, { recursive: true });
    await writeFile(path.join(p.stateDir, "workflow-roles.json"), JSON.stringify(check.roles, null, 2));
  }
  if (Object.keys(check.skills).length || Object.keys(check.notes).length || check.autoSkills.length || check.autoAllImported) {
    await mkdir(p.stateDir, { recursive: true });
    await writeFile(path.join(p.stateDir, "assigned-skills.json"), JSON.stringify({ ...(await assignedSkillsFile(check.skills, check.autoSkills, check.autoAllImported)), ...(Object.keys(check.notes).length ? { notes: check.notes } : {}) }, null, 2));
  }
  return check.args;
}

/**
 * The SKILL.md instructions of each role's assigned skills; disabled or missing skills are left out.
 * "When relevant" implementation skills (the hand-picked list, or every imported skill) go as an index only:
 * name, description and folder. Assessment picks from the index; the engine reads a picked skill's text.
 */
async function assignedSkillsFile(assigned: Record<string, string[]>, autoNames: string[] = [], autoAll = false) {
  const available = (await listSkills(engineDir, store.data.settings.skills.importedDirs))
    .filter((s) => s.source === "imported" && store.data.settings.skills.enabled[s.id] !== false);
  const roles: Record<string, { name: string; instructions: string }[]> = {};
  for (const [role, names] of Object.entries(assigned)) {
    roles[role] = [];
    for (const name of names) {
      const skill = available.find((s) => s.name === name);
      if (!skill || !skill.instructions.trim()) continue;
      if (skill.instructions.length > SKILL_MAX_CHARS) throw new Error(`Skill “${name}” is longer than ${SKILL_MAX_CHARS.toLocaleString("en-US")} characters; shorten its SKILL.md or unassign it.`);
      roles[role].push({ name, instructions: (await skillDeliveryText(skill)).text });
    }
    const total = roles[role].reduce((sum, s) => sum + s.instructions.length, 0);
    if (total > ROLE_SKILLS_MAX_CHARS) throw new Error(`Skills assigned to ${role} are longer than ${ROLE_SKILLS_MAX_CHARS.toLocaleString("en-US")} characters in total; unassign some.`);
  }
  const always = new Set(assigned.implementation ?? []);
  const pool = autoAll ? available : autoNames.map((name) => available.find((s) => s.name === name)).filter((s): s is SkillInfo => Boolean(s));
  const auto: { name: string; description: string; dir: string }[] = [];
  for (const skill of pool) {
    // Too long to deliver, already always-on, a duplicate name, or no text: not offered.
    if (always.has(skill.name) || auto.some((a) => a.name === skill.name) || !skill.instructions.trim() || skill.instructions.length > SKILL_MAX_CHARS) continue;
    // Without a description, the first line of text stands in so Assessment can still judge relevance.
    const description = skill.description.trim() || skill.instructions.split(/\r?\n/).map((l) => l.replace(/^#+\s*/, "").trim()).find(Boolean)!.slice(0, 200);
    auto.push({ name: skill.name, description, dir: skill.dir });
  }
  return { version: 1, roles, ...(auto.length ? { auto: { implementation: auto.slice(0, AUTO_INDEX_MAX) } } : {}) };
}

/** Remote notification channels for the engine, in the environment (webhook URLs carry their own secret). */
const NOTIFY_CHANNELS: NotifyChannel[] = ["webhook", "discord", "slack", "telegram", "email"];
/** A saved channel: URL channels are stored as the URL, Telegram and email as JSON (all encrypted). */
function notifyChannel(kind: NotifyChannel): unknown {
  const raw = store.getSecret(`notify:${kind}`);
  if (!raw || !["telegram", "email"].includes(kind)) return raw ?? null;
  try { return JSON.parse(raw); } catch { return null; }
}
function notifyEnv(p: Project): NodeJS.ProcessEnv {
  const channels = Object.fromEntries(NOTIFY_CHANNELS.map((k) => [k, notifyChannel(k)]));
  if (!Object.values(channels).some(Boolean)) return {};
  return { AGENT_DOCK_NOTIFY: JSON.stringify({ project: p.name, ...channels, digests: store.data.settings.general.notifyDigests !== false }) };
}
function notifyDetails(): Partial<Record<NotifyChannel, string>> {
  const telegram = notifyChannel("telegram") as { chatId?: string } | null, email = notifyChannel("email") as { inbox?: string; to?: string[] } | null;
  return { ...(telegram?.chatId ? { telegram: `chat ${telegram.chatId}` } : {}), ...(email?.inbox ? { email: `${email.inbox} → ${(email.to ?? []).join(", ")}` } : {}) };
}

/** The OpenAI-compatible connection the project's Implementation agent uses, if any. */
function implProvider(p: Project): CliConnection | undefined {
  const impl = agentForRole("implementation", p, agents());
  if (!impl || impl.provider !== "openai") return undefined;
  const selected = impl.providerCliId ? store.data.clis.find((c) => c.id === impl.providerCliId) : undefined;
  return selected
    ? selected.kind === "openai" ? selected : undefined
    : store.data.clis.find((c) => c.kind === "openai");
}

function providerEnv(p: Project): NodeJS.ProcessEnv {
  const provider = implProvider(p);
  const secret = provider ? store.getCliSecret(provider.id) : null;
  return { ...notifyEnv(p), ...(secret ? { AGENT_DOCK_PROVIDER_KEY: secret } : {}), ...(logKey ? { AGENT_DOCK_LOG_KEY: logKey } : {}) };
}

/** Signs action log entries (engine/src/action-log.mjs); kept encrypted, null where the OS has no credential store. */
let logKey: string | null = null;
async function loadLogKey() {
  // Stored as <key>:<when it was made>.
  let saved = store.getSecret("actionlog:key"), created = false;
  if (!saved) {
    const made = `${randomBytes(32).toString("hex")}:${Date.now()}`;
    saved = await store.setSecret("actionlog:key", made).then(() => made, () => null);
    created = Boolean(saved);
  }
  const key = saved ? saved.split(":")[0] : null;
  logKey = key;
  await engine.useLogKey(key).catch((error) => console.error("Action log key not set", error));
  // Logs written before the key existed: their unsigned entries verify up to where they end now, and no further.
  if (created) await engine.checkpointLegacyLogs(store.data.projects.map((p) => p.stateDir));
}

/** Before a start: a warning when the provider reports that the key has no spending limit (asked at most hourly per key). */
const keyLimitChecked = new Map<string, number>();
async function warnUncappedKey(p: Project) {
  const provider = implProvider(p);
  if (!provider || !isOpenRouter(provider.location)) return;
  const secret = store.getCliSecret(provider.id);
  if (!secret || Date.now() - (keyLimitChecked.get(provider.id) ?? 0) < 60 * 60_000) return;
  keyLimitChecked.set(provider.id, Date.now());
  if ((await openRouterKeyLimit(secret)) === "uncapped") notice({ kind: "warning", message: `The OpenRouter key in ${provider.name} has no credit limit. Set a low limit for it on openrouter.ai (Settings › Keys), so a leaked key can cost at most that.` });
}

/**
 * Keeps the OS in step with the schedules marked "also when closed" (packaged builds only): Task Scheduler
 * on Windows, systemd user timers for the AppImage on Linux (its path is in $APPIMAGE).
 */
async function syncWindowsSchedulesNow() {
  if (!app.isPackaged) return;
  // The projects as they are when this sync runs, not when it was asked for.
  if (process.platform === "win32") {
    const problems = await syncOsSchedules(store.data.projects, process.execPath, undefined, undefined, undefined, (message) => console.warn(`[schedule] ${message}`));
    if (problems.length) notice({ kind: "warning", message: `Windows Task Scheduler: ${problems.join(" ")}` });
  } else if (process.platform === "linux") {
    const wanted = store.data.projects.some((p) => p.schedule?.whenClosed);
    if (!process.env.APPIMAGE) { if (wanted) notice({ kind: "warning", message: "Scheduled runs while Agent Dock is closed need the AppImage build on Linux." }); return; }
    const problems = await syncLinuxSchedules(store.data.projects, process.env.APPIMAGE);
    if (problems.length) notice({ kind: "warning", message: `systemd user timers: ${problems.join(" ")}` });
  }
}
// Syncs run one at a time, so an older one never undoes a newer one. A sync that is queued but not yet
// running already reads the latest projects, so further requests join it instead of queueing more.
let scheduleSyncChain: Promise<void> = Promise.resolve();
let scheduleSyncQueued: Promise<void> | null = null;
function syncWindowsSchedules(): Promise<void> {
  if (scheduleSyncQueued) return scheduleSyncQueued;
  const next = scheduleSyncChain.then(() => { scheduleSyncQueued = null; return syncWindowsSchedulesNow(); });
  scheduleSyncQueued = next;
  scheduleSyncChain = next.catch(() => {});
  return next;
}

type ScheduleEvent = "started" | "failed" | "missed";
/**
 * Tells you about a scheduled start beyond the in-app notice: a Windows notification (per the
 * notification settings) and the saved remote channels, which matter most when Task Scheduler launched
 * the app minimized and nobody is watching. A start is informational and never emailed; a failed or
 * missed one needs you and also goes to email. Send failures are logged, never thrown.
 */
async function reportScheduledRun(p: Project, event: ScheduleEvent, message: string) {
  const title = { started: "Scheduled run started", failed: "Scheduled run could not start", missed: "Scheduled run missed" }[event];
  const urgent = event !== "started";
  notice({ kind: event === "started" ? "info" : event === "failed" ? "error" : "warning", message: `${title} on ${p.name}${message ? `: ${message}` : "."}` });
  const general = store.data.settings.general;
  if (urgent ? general.notifyErrors : general.notifyInfo) osNotify(`${title} · ${p.name}`, message.slice(0, 180) || title);
  const channels = NOTIFY_CHANNELS.map((kind) => [kind, notifyChannel(kind)] as const).filter(([kind, value]) => value && (urgent || kind !== "email"));
  if (!channels.length) return;
  const notify = await engine.notifyModule();
  const note = { project: p.name, type: `scheduled-run-${event}`, title, message: message.slice(0, 600) };
  await Promise.all(channels.map(([kind, value]) => notify.sendChannel(kind, value, note, fetch).catch((error: Error) => console.warn(`[schedule] ${kind} notification failed: ${error.message}`))));
}

/** Scheduled runs: once a minute, start each project whose scheduled slot is due and that is not running. */
async function runSchedules(now = new Date()) {
  for (const p of store.data.projects.filter((x) => !x.archived && x.schedule?.enabled)) {
    const slot = dueScheduledStart(p.schedule, now, p.lastScheduledStart);
    // A start missed beyond the grace period (the PC was off or asleep, or Task Scheduler launched the app
    // too late) is skipped, and reported once. Only for "also when closed" schedules: with the app-only
    // kind, a start skipped while the app was closed is the documented behaviour, not news.
    const missed = !slot && p.schedule?.whenClosed ? missedScheduledStart(p.schedule, now, p.lastScheduledStart) : null;
    if (!slot && !missed) continue;
    store.data.projects = store.data.projects.map((x) => (x.id === p.id ? { ...x, lastScheduledStart: slot ?? missed } : x));
    await store.saveProjects();
    if (missed) {
      void reportScheduledRun(p, "missed", `The ${new Date(missed).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })} start was more than ${SCHEDULE_GRACE_MINUTES} minutes late (the PC was off or asleep, or Agent Dock could not start), so it was skipped.`).catch(() => {});
      continue;
    }
    if (engine.isAlive(p.id)) continue;
    try {
      await runControl(p.id, "start", "schedule");
      void reportScheduledRun(p, "started", "").catch(() => {});
    } catch (error) {
      void reportScheduledRun(p, "failed", (error as Error).message).catch(() => {});
    }
  }
}

/** Estimate calibration: what this start expected per plan item, compared later with what the run took. */
async function readEstimates(p: Project): Promise<EstimateRecord[]> {
  try {
    const list = JSON.parse(await readFile(path.join(p.stateDir, ESTIMATES_FILE), "utf8"));
    return Array.isArray(list) ? list.filter((r) => r && typeof r.at === "string" && r.perItem && typeof r.perItem.hours === "number") : [];
  } catch { return []; }
}
async function recordEstimate(p: Project) {
  const record = estimateRecord(await engine.runs(p), taskModeOf({ ...store.data.settings.workflow, ...p.workflowOverrides }));
  if (!record) return;
  await writeFile(path.join(p.stateDir, ESTIMATES_FILE), JSON.stringify([...(await readEstimates(p)), record].slice(-ESTIMATES_KEPT)));
}

/** A control request from the app's buttons or a remote approval (source names who asked, for the action log). */
async function runControl(id: string, action: ControlAction, source = "app") {
  const p = project(id);
  const check = launchCheck(p);
  const starting = ["start", "resume", "resolve", "retry-qa"].includes(action) && !engine.isAlive(id);
  if (starting && check.problems.length) throw new Error(check.problems.join(" "));
  if (starting && check.warnings.length) notice({ kind: "warning", message: check.warnings.join(" ") });
  // Pull-request mode: a fresh start works on its own branch, never on the branch you had checked out.
  if (starting && action === "start" && p.prMode) {
    const runBranch = await ensureRunBranch(p.path, p.prBase ?? null);
    store.data.projects = store.data.projects.map((x) => (x.id === id ? { ...x, prBase: runBranch.base } : x));
    await store.saveProjects();
    if (runBranch.created) notice({ kind: "info", message: `Pull-request mode: working on ${runBranch.branch} (from ${runBranch.base}).` });
  }
  // QA commits in the repository's shared .git; Codex's Windows sandbox can only prepare it when the user owns it.
  if (starting) {
    const owner = await sharedGitOwnerProblem(p.path).catch(() => null);
    if (owner) {
      const fix = ownerFixCommand(owner);
      const message = `QA cannot commit in ${p.name}: ${owner.dir} belongs to ${owner.owner}, not ${owner.user}. ${fix ? `In an Administrator PowerShell run: ${fix}` : "Make your account the owner of that folder (Properties › Security › Advanced), as an Administrator."}`;
      if (action === "retry-qa") throw new Error(message);
      notice({ kind: "warning", message });
    }
  }
  if (starting) void warnUncappedKey(p).catch(() => {});
  const wasAlive = engine.isAlive(id);
  await engine.control(p, action, await launchArgs(p, check), providerEnv(p), source);
  if (starting && action === "start" && engine.isAlive(id)) void recordEstimate(p).catch(() => {});
  if ((p.pendingTaskFile || p.ciNote) && !wasAlive && engine.isAlive(id)) {
    // The attached task and the CI failure note are for this start only.
    store.data.projects = store.data.projects.map((x) => (x.id === id ? { ...x, pendingTaskFile: null, ciNote: null } : x));
    await store.saveProjects();
  }
  void pollOnce();
}

// ---------- signed remote approvals (Telegram buttons, email replies) ----------

let approvals: RemoteApprovals | null = null;
/** What a waiting run offers remotely: the same choices as the attention panel, plus Stop. */
function stateApproval(s: ProjectStatus): { target: string; actions: ApprovalAction[]; title: string; message: string } | null {
  const reason = (s.runState === "attention" ? s.attentionReason : s.runState === "blocked" ? s.blockedReason : s.limitMessage) ?? "";
  const actions: ApprovalAction[] = [];
  if (s.runState === "attention") { actions.push("resume"); if (s.elevateAvailable) actions.push("elevate"); }
  else if (s.runState === "blocked") { if (s.resolverAvailable) actions.push("resolve"); if (s.assessmentRetry) actions.push("resume"); if (s.qaRetry) actions.push("retry-qa"); }
  else if (s.runState === "waiting-limit") actions.push("resume");
  if (!actions.length) return null;
  const title = { attention: "Needs your review", blocked: "Run blocked", "waiting-limit": "Usage limit reached" }[s.runState as "attention" | "blocked" | "waiting-limit"];
  const task = s.task ? `Task ${s.task.id}${s.task.name ? ` · ${s.task.name}` : ""}\n` : "";
  return { target: `state:${s.runState}:${s.task?.id ?? ""}:${reason.slice(0, 80)}`, actions: [...actions, "stop"], title, message: `${task}${reason.slice(0, 1200)}` };
}
function approvalChannels() {
  if (store.data.settings.general.remoteApprovals !== true) return { telegram: null, email: null };
  return { telegram: notifyChannel("telegram") as TelegramChannel | null, email: notifyChannel("email") as EmailChannel | null };
}
async function startApprovals() {
  let key = store.getSecret("approvals:key");
  if (!key) { key = randomBytes(32).toString("hex"); await store.setSecret("approvals:key", key); }
  approvals = new RemoteApprovals({
    key: Buffer.from(key, "hex"), file: path.join(store.dir, "remote-approvals.json"), channels: approvalChannels,
    log: (message) => console.warn(message),
    stillValid: async (r, action) => {
      const p = store.data.projects.find((x) => x.id === r.projectId && !x.archived);
      if (!p) return false;
      if (r.target.startsWith("plan:")) return (await engine.planProposals(p)).some((x) => x.id === r.target.slice(5) && x.status === "pending" && x.applies !== false);
      const now = stateApproval(await engine.status(p));
      return Boolean(now && now.target === r.target && now.actions.includes(action));
    },
    execute: async (r, action, via) => {
      const p = project(r.projectId), source = `remote:${via}`;
      let result: string;
      if (action === "approve-plan" || action === "dismiss-plan") {
        const list = await engine.decidePlanProposal(p, r.target.slice(5), action === "approve-plan" ? "approve" : "dismiss", source);
        const proposal = list.find((x) => x.id === r.target.slice(5));
        result = action === "dismiss-plan" ? "plan change dismissed" : proposal?.status === "applied" ? `plan change committed (${proposal.commit?.slice(0, 7)})` : "plan change approved; it is committed between tasks";
      } else {
        await runControl(r.projectId, action, source);
        result = { resume: "resumed", elevate: "Elevation started", resolve: "resolver started", "retry-qa": "QA restarted", stop: "stopping at the next safe point" }[action];
      }
      await engine.recordEvent(p, { type: "remote-approval", action, via, message: result, source }).catch(() => undefined);
      return result;
    },
  });
  approvals.start();
}

// ---------- status polling, notifications and app-enforced workflow rules ----------

async function handleTransitions(p: Project, prev: ProjectStatus | undefined, next: ProjectStatus) {
  const { settings } = store.data;
  const lastSeen = prev?.events.at(-1)?.timestamp ?? "";
  const fresh = prev ? next.events.filter((e) => e.timestamp > lastSeen) : [];
  for (const event of fresh) {
    if (event.type === "run-limit") osNotify(`Unattended run stopping · ${p.name}`, String(event.message ?? "A run limit was reached."));
    if (event.type === "supervisor-alert" && settings.general.notifyErrors) osNotify(`Supervisor: ${event.monitor ?? "alert"} · ${p.name}`, String(event.message ?? ""));
    if (event.type === "supervisor-digest" && settings.general.notifyInfo && settings.general.notifyDigests !== false) osNotify(`Supervisor digest · ${p.name}`, String(event.message ?? ""));
    if (event.type === "qa-pass") {
      if (settings.general.notifyCompleted) osNotify(`Task approved · ${p.name}`, `${event.taskId ?? "Task"} passed QA${typeof event.attempt === "number" ? ` after ${event.attempt} attempt${event.attempt === 1 ? "" : "s"}` : ""}.`);
      // The engine records automatic Pause before QA PASS; polling must not race
      // the next Assessment or re-pause after the user's Resume.
    }
    if (event.type === "plan-proposal" && approvals && typeof event.id === "string") {
      void approvals.request({ projectId: p.id, projectName: p.name, title: "Supervisor plan change", message: `${String(event.message ?? "")}\n${String(event.preview ?? "")}`, actions: ["approve-plan", "dismiss-plan"], target: `plan:${event.id}` });
    }
    if (isCompactionDone(event) && settings.attention.informational === "windows") {
      osNotify(`Context compacted · ${p.name}`, "The implementation agent's history was compacted.");
    }
  }
  if (approvals && prev && (prev.runState !== next.runState || prev.task?.id !== next.task?.id)) {
    const ask = stateApproval(next);
    if (ask) void approvals.request({ projectId: p.id, projectName: p.name, ...ask });
  }
  if (prev && prev.runState !== next.runState) {
    if (next.runState === "attention") osNotify(`Attention required · ${p.name}`, (next.attentionReason ?? "Manual review requested").slice(0, 180));
    if (next.runState === "blocked") osNotify(`Blocked · ${p.name}`, (next.blockedReason ?? "The task cannot continue safely").slice(0, 180));
    if (next.runState === "waiting-limit" && settings.general.notifyErrors) osNotify(`Usage limit · ${p.name}`, next.limitMessage ?? "Waiting for Resume");
    if (prev.processAlive && !next.processAlive && settings.general.notifyErrors && !["stopped", "complete", "idle"].includes(next.runState)) {
      osNotify(`Automation exited · ${p.name}`, "The engine process ended. See the engine log on the Overview page.");
    }
  }
  if (prev?.processAlive && !next.processAlive && p.ci?.fixing) void ciFixEnded(p.id, next.runState).catch((error: Error) => notice({ kind: "error", message: `CI fix on ${p.name}: ${error.message}` }));
}

// ---------- GitHub CI: the Actions runs of a pushed run branch ----------

const ciStatuses = new Map<string, CiStatus>();
function setCi(id: string, ci: CiWatch | null, extra: Partial<Project> = {}) {
  store.data.projects = store.data.projects.map((x) => (x.id === id ? { ...x, ...extra, ci } : x));
  return store.saveProjects();
}
function ciStatusOf(p: Project): CiStatus {
  const known = ciStatuses.get(p.id);
  return known && known.watch?.sha === p.ci?.sha ? { ...known, watch: p.ci ?? null } : { projectId: p.id, watch: p.ci ?? null, state: p.ci?.state ?? "none", checks: [], message: null, checkedAt: null };
}
const ghPath = async () => pickRunnable(await whereAll("gh"));

/** Reads the watched commit's runs (force: also when final or past the give-up time) and acts when they finish. */
async function pollCi(id: string, force = false): Promise<CiStatus> {
  const p = project(id), w = p.ci;
  if (!w) return ciStatusOf(p);
  if (!force && (isFinal(w.state) || Date.now() - Date.parse(w.pushedAt) > CI_GIVE_UP_MS)) return ciStatusOf(p);
  const gh = await ghPath();
  const r = await readCi({ gh, repo: w.repo, branch: w.branch, sha: w.sha, pushedAt: w.pushedAt, cwd: p.path });
  // The watch may have moved on (a new push) while gh was reading.
  if (project(id).ci?.sha !== w.sha) return ciStatusOf(project(id));
  const watch = { ...project(id).ci!, state: r.state };
  const status: CiStatus = { projectId: id, watch, state: r.state, checks: r.checks, message: r.message, checkedAt: new Date().toISOString() };
  ciStatuses.set(id, status);
  send("ci", status);
  if (r.state !== w.state) {
    await setCi(id, watch);
    if (isFinal(r.state)) await ciFinished(project(id), status, gh);
  }
  return status;
}

async function ciFinished(p: Project, status: CiStatus, gh: string | null) {
  const general = store.data.settings.general;
  const w = status.watch as CiWatch;
  const failed = [...new Set(status.checks.filter((c) => c.bucket === "fail").map((c) => c.workflow || c.name))];
  const word = status.state === "pass" ? "passed" : status.state === "fail" ? "failed" : "was cancelled";
  const message = `CI ${word} on ${w.branch}${failed.length ? `: ${failed.join(", ")}` : ""}.`;
  notice({ kind: status.state === "pass" ? "success" : status.state === "fail" ? "error" : "warning", message: `${p.name}: ${message}` });
  if (status.state === "pass" ? general.notifyCompleted : general.notifyErrors) osNotify(`CI ${word} · ${p.name}`, message.slice(0, 180));
  if (status.state !== "fail" || !p.ciFixLoop || !gh) return;
  if (w.fixAttempts >= CI_FIX_MAX) { notice({ kind: "warning", message: `${p.name}: CI still fails after ${CI_FIX_MAX} fix runs, so the fix loop stopped. The failure is yours to look at.` }); return; }
  if (engine.isAlive(p.id)) { notice({ kind: "warning", message: `${p.name}: CI failed while a run is going; press Fix CI failure when it ends.` }); return; }
  await startCiFix(p.id, status, "ci-fix-loop").catch((error: Error) => notice({ kind: "error", message: `${p.name}: the CI fix run could not start: ${error.message}` }));
}

/** Starts a run whose objective begins with the failed log; the push follows when that run completes. */
async function startCiFix(id: string, status: CiStatus, source: string) {
  const p = project(id), w = p.ci;
  if (!w || status.state !== "fail" || status.watch?.sha !== w.sha) throw new Error("There is no failed CI run to fix for the pushed commit.");
  if (w.fixing) throw new Error("A CI fix run is already working on it.");
  if (engine.isAlive(id)) throw new Error("Stop the automation first.");
  const gh = await ghPath();
  if (!gh) throw new Error("GitHub CLI (gh) is needed to read the failed log.");
  const head = (await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: p.path })).stdout.trim();
  if (head !== w.branch) throw new Error(`The project is on ${head}, not ${w.branch}.`);
  const logs = await failedLogs({ gh, repo: w.repo, cwd: p.path, checks: status.checks });
  await setCi(id, { ...w, fixing: true, fixAttempts: w.fixAttempts + 1 }, { ciNote: ciFixNote(w.branch, w.sha, logs) });
  try {
    await runControl(id, "start", source);
  } catch (error) {
    await setCi(id, { ...w, fixing: false }, { ciNote: null });
    throw error;
  }
  notice({ kind: "info", message: `${p.name}: fixing the CI failure (fix run ${w.fixAttempts + 1} of ${CI_FIX_MAX}).` });
}

/** A fix run ended: a complete run with new commits is pushed and watched again; anything else is left to you. */
async function ciFixEnded(id: string, runState: string) {
  const p = project(id), w = p.ci;
  if (!w?.fixing) return;
  if (runState !== "complete") {
    await setCi(id, { ...w, fixing: false });
    notice({ kind: "warning", message: `${p.name}: the CI fix run ended without completing, so nothing was pushed.` });
    return;
  }
  let sha: string | null;
  try { sha = await pushRunBranch(p.path, w.branch, w.sha); }
  catch (error) { await setCi(id, { ...w, fixing: false }); throw error; }
  if (!sha) {
    await setCi(id, { ...w, fixing: false });
    notice({ kind: "warning", message: `${p.name}: the CI fix run made no commits, so nothing was pushed.` });
    return;
  }
  await setCi(id, { ...w, sha, pushedAt: new Date().toISOString(), state: "pending", fixing: false });
  notice({ kind: "info", message: `${p.name}: pushed the CI fix (${sha.slice(0, 7)}); watching CI again.` });
  void pollCi(id).catch(() => {});
}

function startCiPolling() {
  setInterval(() => {
    for (const p of store.data.projects) if (!p.archived && p.ci) void pollCi(p.id).catch((error: Error) => console.warn(`[ci] ${p.name}: ${error.message}`));
  }, CI_POLL_MS);
}

const lastSent = new Map<string, string>();

async function pollOnce() {
  const active = store.data.settings.activeProjectId;
  for (const p of store.data.projects) {
    if (p.archived) continue;
    if (skipPoll({ active: p.id === active, alive: engine.isAlive(p.id), last: lastStatus.get(p.id) })) continue;
    try {
      const status = await engine.status(p);
      if (engine.isStoppingAfterTask(p.id) && status.processAlive) status.label = "Stopping after task";
      await engine.afterPoll(p, status);
      await handleTransitions(p, lastStatus.get(p.id), status);
      lastStatus.set(p.id, status);
      // Unchanged status is not sent again: the window would only redraw the same thing.
      const serialized = JSON.stringify(status);
      if (lastSent.get(p.id) !== serialized) {
        lastSent.set(p.id, serialized);
        send("status", status);
      }
    } catch (error) {
      console.error("status poll failed", p.name, error);
    }
  }
  updateTray();
}

function startPolling() {
  const tick = async () => {
    await pollOnce();
    setTimeout(tick, 1500);
  };
  void tick();
}

async function checkAllClis() {
  await Promise.all(
    store.data.clis.map(async (c) => {
      const result = await checkCli(c, store.getCliSecret(c.id));
      health.set(c.id, result);
      send("health", result);
    }),
  );
}

// ---------- window and tray ----------

/** The page's own background for the saved style and shade, so the window opens without a flash of another color. */
function windowBackground(settings: Settings) {
  const { style, theme } = normalizeAppearance(settings.general);
  return STYLE_BACKGROUNDS[style][theme];
}

function createWindow() {
  const { style, theme, accent, styleAccents } = normalizeAppearance(store.data.settings.general);
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 620,
    frame: false,
    backgroundColor: STYLE_BACKGROUNDS[style][theme],
    show: false,
    icon: appIcon(256),
    title: "Agent Dock",
    webPreferences: { preload: path.join(__dirname, "../preload/index.js"), sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, devTools: !app.isPackaged },
  });
  win.on("focus", checkOnFocus);
  win.once("ready-to-show", () => {
    if (!store.data.settings.general.startMinimized && !startHidden) win?.show();
  });
  win.on("close", (event) => {
    if (!quitting && store.data.settings.general.keepInTray) {
      event.preventDefault();
      win?.hide();
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalWebUrl(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  // The window only ever shows the bundled renderer; links open in the browser instead.
  win.webContents.on("will-navigate", (event, url) => {
    event.preventDefault();
    if (isExternalWebUrl(url)) void shell.openExternal(url);
  });
  // The style rides on the query string so the renderer applies it before the settings snapshot arrives.
  const look = { ui: style, theme, accent: styleAccent({ accent, styleAccents }, style) };
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}?${new URLSearchParams(look)}`);
  else void win.loadURL(appUrl(look));
}

function showWindow() {
  if (!win) createWindow();
  win?.show();
  win?.focus();
}

function updateTray() {
  if (!tray) return;
  const statuses = [...lastStatus.values()];
  const attention = statuses.filter((s) => ["attention", "blocked"].includes(s.runState)).length;
  const running = statuses.filter((s) => s.processAlive).length;
  tray.setToolTip(`Agent Dock\n${running} running${attention ? ` · ${attention} need attention` : ""}`);
  tray.setImage(appIcon(32, attention ? [232, 168, 124] : running ? [112, 199, 165] : null));
}

function createTray() {
  tray = new Tray(appIcon(32));
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open", click: showWindow },
      { type: "separator" },
      { label: "Stop all at next safe point", click: () => void stopAll(false) },
      { label: "Stop all now…", click: () => void confirmStopAllNow() },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() },
    ]),
  );
  tray.on("click", showWindow);
  updateTray();
}

/** Stops every project whose engine is running; the action log records each stop with source "app". */
async function stopAll(now: boolean) {
  const results: { project: string; result: string }[] = [];
  for (const p of store.data.projects) {
    if (!(await engine.refreshAlive(p))) continue;
    try {
      await engine.control(p, now ? "stop-now" : "stop", []);
      results.push({ project: p.name, result: now ? "stopped now" : "stopping at the next safe point" });
    } catch (error) {
      results.push({ project: p.name, result: `failed: ${(error as Error).message}` });
    }
  }
  void pollOnce();
  osNotify("Stop all", results.length ? results.map((r) => `${r.project}: ${r.result}`).join("\n") : "No project was running.");
  return results;
}

async function confirmStopAllNow() {
  const { response } = await dialog.showMessageBox({ type: "warning", buttons: ["Stop all now", "Cancel"], defaultId: 1, cancelId: 1, title: "Stop all now", message: "Stop every running project at once?", detail: "Engines and their workers are killed mid-task. Unfinished work stays in the working tree for you to inspect." });
  if (response === 0) await stopAll(true);
}

/** Keeps the terminal stop-all launcher in the config folder current with this install. */
async function writeStopLauncher() {
  const launcher = stopLauncher({ platform: process.platform, execPath: process.execPath, script: path.join(engineDir, "src", "stop-all.mjs"), configDir: store.dir });
  await writeFile(launcher.file, launcher.content, { mode: 0o700 });
  rememberContent(launcher.file, launcher.content);
  return launcher.file;
}
let stopAllPath = "";

/** A native confirmation (the window cannot answer it) before a safety control is weakened. */
/** A connection's address changed: send its saved key there, or remove the key. */
async function confirmKeyMove(name: string, location: string): Promise<boolean> {
  const options = {
    type: "warning" as const,
    buttons: ["Remove the saved key", "Use it at the new address"],
    defaultId: 0,
    cancelId: 0,
    title: "Send the saved key to a new address?",
    message: `${name} now points to ${location.slice(0, 200)}.`,
    detail: "Its saved API key would be sent there. Keep it only if you changed the address yourself and trust it.",
  };
  const { response } = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
  return response === 1;
}

async function confirmWeakening(labels: string[]): Promise<boolean> {
  const options = {
    type: "warning" as const,
    buttons: ["Keep the current setting", "Apply"],
    defaultId: 0,
    cancelId: 0,
    title: "Weaken Agent Dock's safety?",
    message: "This change weakens a safety control or chooses a program Agent Dock runs:",
    detail: `${labels.map((l) => `• ${l}`).join("\n")}\n\nApply it only if you made this change yourself.`,
  };
  const { response } = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
  return response === 1;
}

/**
 * Project checks run code agents can edit (npm test runs package.json scripts and tests). Unless the user
 * trusts them (Settings › Execution & safety), while any run is going the app puts back changes to its
 * own config files and stops every run when those or its engine files were changed by something else.
 */
let integrityBusy = false;
async function checkIntegrity(): Promise<void> {
  if (integrityBusy || store.data.settings.safety.checksTrusted === true) return;
  const running = store.data.projects.filter((p) => engine.isAlive(p.id));
  if (!running.length) return;
  integrityBusy = true;
  try {
    // Anything that cannot be checked counts as changed: a failure here stops runs, it never skips the check.
    const { restored, failed } = await restoreWatchedFiles().catch((error: Error) => ({ restored: [] as string[], failed: [{ file: "config", error: error.message }] }));
    let engineChanges: string[];
    try { engineChanges = engine.fileProblems(); } catch (error) { engineChanges = [`could not be checked (${(error as Error).message})`]; }
    if (!restored.length && !failed.length && !engineChanges.length) return;
    for (const p of running) await engine.control(p, "stop-now", [], {}, "integrity").catch(() => undefined);
    const files = [...restored.map((f) => `${path.basename(f)} (put back; the changed copy is beside it)`), ...failed.map((f) => `${path.basename(f.file)} (could not be checked or put back: ${f.error})`), ...engineChanges.map((c) => `engine: ${c}`)];
    for (const p of running) await engine.recordEvent(p, { type: "integrity-stop", files }).catch(() => undefined);
    const message = `Stopped every run: something other than Agent Dock changed its own files while a run was going (${files.slice(0, 4).join(", ")}${files.length > 4 ? ", …" : ""}). Project checks run code agents can edit; review the last task's changes before you resume.`;
    notice({ kind: "error", message });
    osNotify("Agent Dock stopped every run", message);
  } finally {
    integrityBusy = false;
  }
}

/** The user guide and How it works, bundled with the app (extraResources) so Settings › Help works offline. */
const docsDir = app.isPackaged ? path.join(process.resourcesPath, "docs") : path.join(app.getAppPath(), "docs");
const BUNDLED_DOCS = ["user-guide.md", "how-it-works.md"] as const;
let bundledDocs: Partial<Record<(typeof BUNDLED_DOCS)[number], string>> | null = null;
/** Only the guides found on disk; Settings falls back to GitHub for a missing one. */
const localDocs = () => (bundledDocs ??= Object.fromEntries(BUNDLED_DOCS.map((f) => [f, path.join(docsDir, f)] as const).filter(([, file]) => existsSync(file))));

// ---------- IPC ----------

function snapshot() {
  return { projects: store.data.projects, agents: agents(), clis: store.data.clis.map((c) => ({ ...c, hasSecret: store.hasCliSecret(c.id) })), settings: store.data.settings, engine: engineInfo, roles: roles.roles, paths: { config: store.dir, projectState: stateRoot, stopAll: stopAllPath, docs: localDocs() }, notifyChannels: Object.fromEntries(NOTIFY_CHANNELS.map((k) => [k, store.hasSecret(`notify:${k}`)])) as Record<NotifyChannel, boolean>, notifyDetails: notifyDetails(), version: app.getVersion() };
}

/** Activity-derived usage per project, reused while activity.ndjson is unchanged. */
const activityUsage = new Map<string, { key: string; records: TokenRecord[]; compactions: number }>();

async function projectActivityUsage(p: Project) {
  const info = await stat(path.join(p.stateDir, "activity.ndjson")).catch(() => null);
  const key = info ? `${info.size}:${info.mtimeMs}` : "none";
  const cached = activityUsage.get(p.id);
  if (cached?.key === key) return cached;
  const events = await readActivity(p.stateDir, 20_000);
  const value = { key, records: implementationUsage(events, p.id), compactions: countCompactions(events) };
  activityUsage.set(p.id, value);
  return value;
}

async function usage(projectId: string | null): Promise<UsageSummary> {
  const targets = projectId ? [project(projectId)] : store.data.projects;
  const records = [];
  let compactions = 0;
  let limit = { message: null as string | null, retryAt: null as string | null };
  for (const p of targets) {
    const fromActivity = await projectActivityUsage(p);
    records.push(...(await readOrchestratorUsage(p.stateDir, p.id)), ...fromActivity.records);
    compactions += fromActivity.compactions;
    const s = lastStatus.get(p.id);
    if (s?.limitMessage) limit = { message: s.limitMessage, retryAt: s.limitRetryAt };
  }
  const alive = projectId ? await engine.refreshAlive(project(projectId)) : null;
  return { records: records.sort((a, b) => a.timestamp.localeCompare(b.timestamp)), compactions, sessionStartedAt: alive?.startedAt ?? null, limit };
}

/** Overview › Runs › Export: one run's report as Markdown or HTML, saved where the user picks. */
async function exportRunReport(projectId: string, startedAt: string, format: "md" | "html"): Promise<string | null> {
  const p = project(projectId);
  const report = (await engine.runs(p)).find((r) => r.startedAt === startedAt);
  if (!report) throw new Error("That run's report was not found.");
  const name = `${p.name.replace(/[^\w.-]+/g, "-")}-run-${startedAt.slice(0, 16).replace(/[:T]/g, "-")}.${format}`;
  const result = await dialog.showSaveDialog(win!, { title: "Export run report", defaultPath: path.join(app.getPath("documents"), name), filters: [format === "md" ? { name: "Markdown", extensions: ["md"] } : { name: "Web page", extensions: ["html"] }] });
  if (result.canceled || !result.filePath) return null;
  await writeFile(result.filePath, format === "md" ? runReportMarkdown(report, p.name) : runReportHtml(report, p.name));
  return result.filePath;
}

/** Settings › Advanced › Export settings: agents, roles, connections and settings, without secrets or projects. */
async function exportSettingsFile(): Promise<string | null> {
  const result = await dialog.showSaveDialog(win!, { title: "Export settings", defaultPath: path.join(app.getPath("documents"), `agent-dock-settings-${new Date().toISOString().slice(0, 10)}.json`), filters: [{ name: "Agent Dock settings", extensions: ["json"] }] });
  if (result.canceled || !result.filePath) return null;
  const file = exportSettings({ settings: store.data.settings, agents: agents(), clis: store.data.clis, roles: roles.roles, appVersion: app.getVersion() });
  await writeFile(result.filePath, JSON.stringify(file, null, 2) + "\n");
  return result.filePath;
}

/** Settings › Advanced › Import settings: replaces settings, adds or replaces agents, roles and connections by id. */
async function importSettingsFile(): Promise<{ agents: number; clis: number; roles: number; skipped: string[] } | null> {
  const picked = await dialog.showOpenDialog(win!, { title: "Import settings", properties: ["openFile"], filters: [{ name: "Agent Dock settings", extensions: ["json"] }] });
  if (picked.canceled || !picked.filePaths[0]) return null;
  const file = parseSettingsFile(await readFile(picked.filePaths[0], "utf8"));
  if ([...lastStatus.values()].some((s) => s.processAlive)) throw new Error("Stop every running project before importing settings.");
  const merged = mergeImport({ settings: store.data.settings, agents: agents(), clis: store.data.clis }, file);
  const { response } = await dialog.showMessageBox(win!, {
    type: "question", buttons: ["Import", "Cancel"], defaultId: 0, cancelId: 1, title: "Import settings",
    message: `Import settings from ${path.basename(picked.filePaths[0])}?`,
    detail: `Exported from Agent Dock ${file.appVersion} on ${file.exportedAt.slice(0, 10)}. Your settings are replaced; ${merged.summary.agents} agent${merged.summary.agents === 1 ? "" : "s"}, ${merged.summary.roles} workflow role${merged.summary.roles === 1 ? "" : "s"} and ${merged.summary.clis} connection${merged.summary.clis === 1 ? "" : "s"} are added or replace the ones with the same id. Projects, API keys and secret values stay as they are on this computer; enter any missing keys in CLIs. Program locations (CLI paths, llama.cpp launcher, Node runtime) are not imported, the tool guard stays on if it is on here, and protected paths are added to yours.${merged.summary.skipped.length ? `\n\nNot imported: ${merged.summary.skipped.join(", ")}.` : ""}`,
  });
  if (response !== 0) return null;
  store.data.settings = merged.settings;
  store.data.agents = merged.agents;
  store.data.clis = merged.clis;
  await Promise.all([store.saveSettings(), store.saveAgents(), store.saveClis()]);
  for (const role of merged.roles) await roles.save(role);
  limits.schedule(store.data.settings);
  scheduleUpdateChecks();
  win?.setBackgroundColor(windowBackground(store.data.settings));
  return merged.summary;
}

/** Settings › Advanced › Export diagnostics: a zip for bug reports, with every secret removed. */
async function exportDiagnostics(): Promise<string | null> {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, "-");
  const result = await dialog.showSaveDialog(win!, { title: "Export diagnostics", defaultPath: path.join(app.getPath("downloads"), `agent-dock-diagnostics-${stamp}.zip`), filters: [{ name: "Zip archive", extensions: ["zip"] }] });
  if (result.canceled || !result.filePath) return null;
  // Every stored secret plus the values Agent Dock passes to engines and CLIs.
  const secrets = [...store.secretValues(), ...store.data.clis.flatMap((c) => c.env.filter((e) => e.secret).map((e) => e.value))];
  const tools = await engine.diagnosticsTools(secrets);
  const entries = await collectDiagnostics({
    about: { app: "Agent Dock", version: app.getVersion(), packaged: app.isPackaged, build: updater?.status ? { installed: updater.status.installed, state: updater.status.state, error: updater.status.error, log: updater.status.log.slice(-40) } : null, platform: process.platform, arch: process.arch, os: `${os.type()} ${os.release()}`, electron: process.versions.electron, node: process.versions.node, chrome: process.versions.chrome, engine: engineInfo, createdAt: new Date().toISOString() },
    settings: store.data.settings, agents: agents(), clis: store.data.clis, roles: roles.roles, projects: store.data.projects,
    statuses: Object.fromEntries(lastStatus), verifyActionLog: tools.verifyActionLog, redact: tools.redact,
    logs: { "updater-swap.log": path.join(STAGING, "swap.log") },
  });
  await writeFile(result.filePath, zipFiles(entries));
  shell.showItemInFolder(result.filePath);
  return result.filePath;
}

function registerIpc() {
  const handle = (channel: string, fn: (...args: any[]) => unknown) =>
    ipcMain.handle(channel, (event, ...args) => {
      // Only the app's own window may call into the main process.
      if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error("IPC sender not allowed");
      return fn(...args);
    });

  handle("snapshot", snapshot);
  handle("settings:save", async (incoming: unknown) => {
    const previous = store.data.settings.usage;
    const previousUpdates = store.data.settings.updates;
    // The window is not trusted with the shape of settings, nor with weakening a safety control on its own.
    const settings = sanitizeSettings(incoming, store.data.settings);
    const weaker = weakenings(store.data.settings, settings);
    if (weaker.length && !(await confirmWeakening(weaker.map((w) => w.label)))) for (const w of weaker) w.revert(settings);
    store.data.settings = settings;
    await store.saveSettings();
    win?.setBackgroundColor(windowBackground(settings));
    if (previous.codexPollMinutes !== settings.usage.codexPollMinutes || previous.claudePollMinutes !== settings.usage.claudePollMinutes) limits.schedule(settings);
    if (previousUpdates.autoCheck !== settings.updates.autoCheck || previousUpdates.checkMinutes !== settings.updates.checkMinutes) scheduleUpdateChecks();
    app.setLoginItemSettings({ openAtLogin: settings.general.launchAtStartup, args: settings.general.startMinimized ? ["--minimized"] : [] });
    return settings;
  });
  handle("agent:save", async (agent: Agent) => {
    const list = agents();
    const i = list.findIndex((a) => a.id === agent.id);
    store.data.agents = i >= 0 ? list.map((a) => (a.id === agent.id ? agent : a)) : [...list, agent];
    await store.saveAgents();
    return agents();
  });
  handle("agent:delete", async (id: string) => {
    store.data.agents = agents().filter((a) => a.id !== id);
    await store.saveAgents();
    return agents();
  });
  handle("cli:save", async (cli: CliConnection, secret?: string | null) => {
    // Per-run settings only for Codex, Claude Code, Cline and OpenCode, and only listed, valid ones.
    if (isRunSettingKind(cli.kind)) cli = { ...cli, runSettings: cleanRunSettings(cli.kind, cli.runSettings) };
    else delete cli.runSettings;
    if (!isConnectionId(cli?.id) || !isCliKind(cli.kind) || typeof cli.location !== "string") throw new Error("Invalid connection");
    store.assertSecretEnvStorable(cli);
    const i = store.data.clis.findIndex((c) => c.id === cli.id);
    const before = i >= 0 ? store.data.clis[i] : undefined;
    if (before && before.kind !== cli.kind) throw new Error("A connection's kind cannot change; add a new connection instead.");
    // The saved key goes to a new address only when the user says so.
    if (secret === undefined && before && before.location !== cli.location && store.hasCliSecret(cli.id) && !(await confirmKeyMove(cli.name || cli.id, cli.location))) secret = null;
    store.data.clis = i >= 0 ? store.data.clis.map((c) => (c.id === cli.id ? cli : c)) : [...store.data.clis, cli];
    if (secret !== undefined) await store.setCliSecret(cli.id, secret);
    await store.saveClis();
    return snapshot().clis;
  });
  const configKind = (kind: unknown) => {
    if (kind !== "codex" && kind !== "claude") throw new Error("Only Codex's and Claude Code's config files are edited here.");
    return kind;
  };
  handle("cli:configFile", (kind: unknown) => readConfigFile(configKind(kind)));
  handle("cli:saveConfigFile", (kind: unknown, text: unknown, mtimeMs: unknown) => {
    if (typeof text !== "string" || (mtimeMs !== null && typeof mtimeMs !== "number")) throw new Error("Invalid config file save");
    return writeConfigFile(configKind(kind), text, mtimeMs);
  });
  handle("cli:ollamaSettings", () => readOllamaSettings());
  handle("cli:saveOllamaSettings", async (changes: Record<string, string | null>) => {
    const state = await writeOllamaSettings(changes ?? {});
    // Requests at once is also the most parallel tasks a local Ollama connection gets: keep them the same.
    if ("OLLAMA_NUM_PARALLEL" in (changes ?? {})) {
      const atOnce = Math.max(1, Number(state.saved.OLLAMA_NUM_PARALLEL) || 1);
      store.data.clis = store.data.clis.map((c) => (c.kind === "ollama" && isLocalUrl(c.location) ? { ...c, parallelRequests: atOnce } : c));
      await store.saveClis();
    }
    return { state, clis: snapshot().clis };
  });
  handle("cli:collectModels", async (id: string) => {
    const conn = store.data.clis.find((c) => c.id === id);
    if (!conn) throw new Error("Connection not found");
    if (conn.kind !== "llamacpp" && conn.kind !== "ollama") throw new Error("Only local providers list models here");
    const collected = conn.kind === "ollama" ? await collectOllama(conn.location.replace(/\/$/, "")) : await collectLlamaCpp(conn, store.data.settings.advanced.llamaCppLauncher, undefined, pickRunnable(await whereAll("llama-server")));
    store.data.clis = store.data.clis.map((c) => (c.id === id ? { ...c, collected } : c));
    await store.saveClis();
    return snapshot().clis;
  });
  handle("cli:detectModelsDir", () => detectLlamaModelsDir(store.data.settings.advanced.llamaCppLauncher));
  handle("cli:delete", async (id: string) => {
    store.data.clis = store.data.clis.filter((c) => c.id !== id);
    await store.setCliSecret(id, null);
    await store.saveClis();
    return snapshot().clis;
  });
  handle("cli:check", async (id: string) => {
    const conn = store.data.clis.find((c) => c.id === id);
    if (!conn) throw new Error("Connection not found");
    const result = await checkCli(conn, store.getCliSecret(id));
    health.set(id, result);
    send("health", result);
    return result;
  });
  handle("cli:healths", () => [...health.values()]);
  // A test from the window may use the saved key only for that saved connection at its saved address.
  handle("cli:test", (cli: CliConnection, secret?: string | null) => {
    if (!isCliKind(cli?.kind)) throw new Error("Unknown kind of connection");
    const saved = store.data.clis.find((c) => c.id === cli.id);
    const savedKey = saved && saved.kind === cli.kind && saved.location === cli.location ? store.getCliSecret(saved.id) : null;
    return checkCli(cli, secret ?? savedKey);
  });
  handle("cli:detect", (command: string) => detectOnPath(command));
  handle("cli:discover", async () => {
    const found = await discoverClis(store.data.clis, systemProbes(whereAll));
    if (found.length) {
      store.data.clis = [...store.data.clis, ...found];
      await store.saveClis();
    }
    return snapshot().clis;
  });
  handle("dialog:directory", async (title: string) => {
    const result = await dialog.showOpenDialog(win!, { title, properties: ["openDirectory", "createDirectory"] });
    return result.canceled ? null : result.filePaths[0];
  });
  handle("dialog:task", async () => {
    const result = await dialog.showOpenDialog(win!, { title: "Attach first task (task.json)", properties: ["openFile"], filters: [{ name: "Task JSON", extensions: ["json"] }] });
    if (result.canceled) return null;
    const file = result.filePaths[0];
    const task = JSON.parse(await readFile(file, "utf8"));
    await engine.validateTask(task);
    return file;
  });
  handle("project:inspect", (dir: string) => inspectDirectory(dir));
  handle("project:add", async (request: AddProjectRequest) => {
    const p = await addProject(request, store.data.projects, stateRoot);
    store.data.projects.push(p);
    await store.saveProjects();
    return p;
  });
  // Planner: one run per project at a time; cancel aborts the HTTP call or stops the CLI.
  handle("planner:generate", async (projectId: string, cliId: string, model: string | null) => {
    const p = project(projectId);
    const connection = store.data.clis.find((c) => c.id === cliId);
    if (!connection || !(PLANNER_KINDS as readonly string[]).includes(connection.kind)) throw new Error("Choose a planner.");
    planners.get(projectId)?.abort();
    const controller = new AbortController();
    planners.set(projectId, controller);
    try {
      return await generatePlan(p.path, p.objective, { connection, model: model?.trim() || null, apiKey: connection.kind === "openai" ? store.getCliSecret(connection.id) : null }, controller.signal);
    } finally {
      if (planners.get(projectId) === controller) planners.delete(projectId);
    }
  });
  handle("planner:cancel", (projectId: string) => { planners.get(projectId)?.abort(); });
  handle("planner:save", (projectId: string, text: string) => savePlan(project(projectId).path, String(text)));
  handle("project:update", async (p: Project) => {
    const before = store.data.projects.find((x) => x.id === p.id);
    // A project's own workflow settings override the global ones, so weakening a safety control there
    // (tool guard off for this project) needs the same native confirmation as in Settings.
    if (before) {
      const overrides = p.workflowOverrides && typeof p.workflowOverrides === "object" && !Array.isArray(p.workflowOverrides) ? p.workflowOverrides : {};
      if (overrides.toolGuard !== undefined && typeof overrides.toolGuard !== "boolean") delete overrides.toolGuard;
      const withOverrides = (o: Project["workflowOverrides"]): Settings => ({ ...store.data.settings, workflow: { ...store.data.settings.workflow, ...o } });
      const weaker = weakenings(withOverrides(before.workflowOverrides ?? {}), withOverrides(overrides));
      if (weaker.length && !(await confirmWeakening(weaker.map((w) => `${w.label} for ${before.name}`)))) {
        if (before.workflowOverrides?.toolGuard === undefined) delete overrides.toolGuard;
        else overrides.toolGuard = before.workflowOverrides.toolGuard;
      }
      p = { ...p, workflowOverrides: overrides };
    }
    // The scheduler owns lastScheduledStart; a window's older copy never resets it. A changed schedule
    // counts its slots already past as handled, so they are never reported as missed starts.
    const passed = JSON.stringify(before?.schedule) !== JSON.stringify(p.schedule) ? lastPassedSlot(p.schedule, new Date()) : null;
    const handled = (last?: string | null) => (passed && (!last || Date.parse(passed) > Date.parse(last)) ? passed : last ?? null);
    // The project folder and its state folder are set when the project is added, never by a window.
    store.data.projects = store.data.projects.map((x) => (x.id === p.id ? { ...p, path: x.path, stateDir: x.stateDir, lastScheduledStart: handled(x.lastScheduledStart), ci: x.ci ?? null, ciNote: x.ciNote ?? null } : x));
    await store.saveProjects();
    if (JSON.stringify([before?.schedule, before?.archived]) !== JSON.stringify([p.schedule, p.archived])) void syncWindowsSchedules().catch(() => {});
    return store.data.projects;
  });
  handle("project:remove", async (id: string, deleteHistory: boolean) => {
    const p = project(id);
    if (engine.isAlive(id)) throw new Error("Stop the automation for this project before removing it.");
    store.data.projects = store.data.projects.filter((x) => x.id !== id);
    if (store.data.settings.activeProjectId === id) store.data.settings.activeProjectId = store.data.projects.find((x) => !x.archived)?.id ?? null;
    await Promise.all([store.saveProjects(), store.saveSettings()]);
    // Only ever delete app-managed engine state, never the workspace or a user-chosen state folder.
    const managed = managedProjectFolder(stateRoot, p.stateDir);
    if (deleteHistory && managed) await rm(managed, { recursive: true, force: true });
    lastStatus.delete(id);
    if (p.schedule?.whenClosed) void syncWindowsSchedules().catch(() => {});
    return store.data.projects;
  });
  handle("project:activate", async (id: string | null) => {
    store.data.settings.activeProjectId = id;
    await store.saveSettings();
    void pollOnce();
  });
  handle("project:history", async (id: string) => {
    const p = project(id), saved = await savedTaskIds(p.stateDir);
    return taskHistory(await readActivity(p.stateDir, 20_000)).map((h) => ({ ...h, canRerun: canRerun(saved, h.taskId) }));
  });
  handle("project:addLane", async (parentId: string, name: string, objective: string) => {
    const parent = project(parentId);
    if (parent.parentId) throw new Error("Add lanes to the main project, not to another lane.");
    const lane = await addLaneWorktree(parent.path, String(name));
    try {
      const p = await addProject({ mode: "local", path: lane.path, name: `${parent.name} · ${String(name).trim()}`, objective: String(objective).trim() || parent.objective }, store.data.projects, stateRoot);
      store.data.projects.push({ ...p, parentId, laneBranch: lane.branch, roleOverrides: { ...parent.roleOverrides }, workflowOverrides: { ...parent.workflowOverrides } });
    } catch (error) {
      await removeLaneWorktree(parent.path, lane.path, true).catch(() => {});
      throw error;
    }
    await store.saveProjects();
    return store.data.projects;
  });
  handle("project:mergeLane", async (id: string) => {
    const lane = project(id);
    if (!lane.parentId || !lane.laneBranch) throw new Error("This project is not a parallel lane.");
    const parent = project(lane.parentId);
    if (engine.isAlive(id) || engine.isAlive(parent.id)) throw new Error("Stop the lane's and the project's automation first.");
    const name = lane.name.startsWith(`${parent.name} · `) ? lane.name.slice(parent.name.length + 3) : lane.name;
    const merged = await mergeLaneBranch(parent.path, lane.path, lane.laneBranch, name);
    notice({ kind: "success", message: `Merged ${lane.laneBranch} into ${merged.into} (${merged.commits} commit${merged.commits === 1 ? "" : "s"}, ${merged.commit.slice(0, 7)}). Remove the lane when you no longer need it.` });
    return merged;
  });
  handle("project:removeLane", async (id: string, force: boolean) => {
    const lane = project(id);
    if (!lane.parentId) throw new Error("This project is not a parallel lane.");
    if (engine.isAlive(id)) throw new Error("Stop the lane's automation first.");
    const parent = store.data.projects.find((x) => x.id === lane.parentId);
    try { await removeLaneWorktree(parent?.path ?? lane.path, lane.path, force === true); }
    catch (error) { throw new Error(`${(error as Error).message} Commit or discard the lane's changes in its folder first.`); }
    store.data.projects = store.data.projects.filter((x) => x.id !== id);
    if (store.data.settings.activeProjectId === id) store.data.settings.activeProjectId = lane.parentId;
    await Promise.all([store.saveProjects(), store.saveSettings()]);
    lastStatus.delete(id);
    return store.data.projects;
  });
  // Kept parallel-task worktrees and branches. A lane shares its parent's git repo, so a run in any of
  // them blocks cleanup (it could be creating or merging a parallel branch right now).
  const repoRunning = (p: Project) => store.data.projects.some((x) => [x.id, x.parentId].some((id) => id === p.id || (!!p.parentId && id === p.parentId)) && engine.isAlive(x.id));
  handle("project:parallelLeftovers", async (id: string) => {
    const p = project(id);
    if (!existsSync(p.path)) return { worktrees: [], branches: [] };
    return listParallelLeftovers(p.path, p.stateDir).catch(() => ({ worktrees: [], branches: [] }));
  });
  handle("project:cleanParallel", async (id: string) => {
    const p = project(id);
    if (repoRunning(p)) throw new Error("Stop the automation for this project and its lanes first.");
    return cleanParallelWorktrees(p.path, p.stateDir);
  });
  handle("wsl:check", async (distro: string) => {
    if (process.platform !== "win32") return { ok: false, lines: ["WSL isolation is for Windows."] };
    if (!/^[\w.-]{1,64}$/.test(String(distro))) return { ok: false, lines: ["Enter the distro's name (wsl -l shows them)."] };
    const r = await run("wsl.exe", ["-d", String(distro), "--exec", "sh", "-lc", "for c in node git codex claude cline opencode; do p=$(command -v $c) && echo \"$c: $p\" || echo \"$c: not found\"; done; node --version 2>/dev/null"], { timeoutMs: 60_000 });
    const lines = (r.stdout || r.stderr).replace(/\0/g, "").trim().split(/\r?\n/).filter(Boolean);
    return { ok: r.code === 0 && lines.some((l) => /^node: \//.test(l)) && lines.some((l) => /^git: \//.test(l)), lines };
  });
  handle("project:openPullRequest", async (id: string) => {
    const p = project(id);
    if (!p.prMode) throw new Error("Turn on pull-request mode for this project first.");
    if (engine.isAlive(id)) throw new Error("Stop the automation first, so the branch is complete.");
    const report = (await engine.runs(p))[0];
    const body = [p.objective.trim(), "", report ? runReportMarkdown(report, p.name) : "", "_Opened by Agent Dock in pull-request mode._"].join("\n");
    const { url, created, branch, sha, repo } = await openPullRequest(p.path, p.prBase ?? "main", `${p.name}: ${p.objective.trim().split(/\r?\n/)[0].slice(0, 80)}`, body, await ghPath());
    // Your push starts a fresh watch, and the fix loop's count starts again.
    if (repo) {
      await setCi(id, { repo, branch, sha, pushedAt: new Date().toISOString(), prUrl: /\/pull\/\d+$/.test(url) ? url : null, state: "pending", fixAttempts: 0, fixing: false });
      void pollCi(id).catch(() => {});
    }
    void shell.openExternal(url);
    notice({ kind: "success", message: created ? `Pull request opened: ${url}` : `Branch pushed; finish the pull request in your browser.` });
    return url;
  });
  handle("project:estimates", (id: string) => readEstimates(project(id)));
  handle("project:ciStatus", (id: string) => ciStatusOf(project(id)));
  handle("project:ciRefresh", (id: string) => pollCi(id, true));
  handle("project:ciFix", async (id: string) => {
    await startCiFix(id, await pollCi(id, true), "app");
    return ciStatusOf(project(id));
  });
  handle("project:rerunTask", async (id: string, taskId: string) => {
    const p = project(id);
    if (engine.isAlive(id)) throw new Error("Stop the automation first; the task runs again as the next start's first task.");
    const file = await prepareRerun(p.stateDir, String(taskId));
    store.data.projects = store.data.projects.map((x) => (x.id === id ? { ...x, pendingTaskFile: file } : x));
    await store.saveProjects();
    await runControl(id, "start");
  });
  handle("project:gitOwner", async (id: string) => {
    const problem = await sharedGitOwnerProblem(project(id).path);
    // No command for a folder name a command cannot carry safely: a PowerShell comment with the manual steps instead.
    return problem ? { ...problem, command: ownerFixCommand(problem) ?? "# No command for this folder name. In Explorer: the folder's Properties › Security › Advanced › Owner: Change" } : null;
  });
  handle("engine:status", (id: string) => engine.status(project(id)));
  handle("engine:check", (id: string) => launchCheck(project(id)));
  handle("engine:control", (id: string, action: ControlAction) => runControl(id, action));
  handle("engine:log", (id: string) => engine.engineLog(project(id)));
  handle("engine:setAside", async (id: string) => { const r = await engine.setAside(project(id)); void pollOnce(); return r; });
  handle("notify:setChannel", async (kind: NotifyChannel, value: string | Record<string, string> | null) => {
    if (!NOTIFY_CHANNELS.includes(kind)) throw new Error("Unknown channel");
    const checked = value ? (await engine.notifyModule()).checkChannel(kind, value) : null;
    await store.setSecret(`notify:${kind}`, checked === null ? null : typeof checked === "string" ? checked : JSON.stringify(checked));
    return snapshot();
  });
  handle("notify:test", async (kind: NotifyChannel) => {
    const value = NOTIFY_CHANNELS.includes(kind) ? notifyChannel(kind) : null;
    if (!value) throw new Error("Nothing saved for this channel");
    await (await engine.notifyModule()).sendChannel(kind, value, { type: "test", title: "Agent Dock test", message: "Notifications from Agent Dock will arrive here." }, fetch);
  });
  handle("engine:stopAll", (now: boolean) => (now === true ? stopAll(true) : stopAll(false)));
  handle("engine:verifyLogs", async () => Promise.all(store.data.projects.filter((p) => !p.archived).map(async (p) => {
    try { const r = await engine.verifyActionLog(p); return { project: p.name, ok: r.ok, entries: r.entries, lastAt: r.lastAt, brokenAt: r.brokenAt, reason: r.reason, signed: r.signed ?? null, unsigned: r.unsigned ?? 0 }; }
    catch (error) { return { project: p.name, ok: false, entries: 0, lastAt: null, reason: (error as Error).message }; }
  })));
  handle("plan:proposals", (id: string) => engine.planProposals(project(id)));
  handle("project:runs", (id: string) => engine.runs(project(id)));
  handle("project:exportRun", (id: string, startedAt: string, format: "md" | "html") => exportRunReport(id, String(startedAt), format === "html" ? "html" : "md"));
  handle("diagnostics:export", exportDiagnostics);
  handle("settings:export", exportSettingsFile);
  handle("settings:import", importSettingsFile);
  handle("plan:decide", (id: string, proposalId: string, decision: "approve" | "dismiss") => engine.decidePlanProposal(project(id), proposalId, decision === "approve" ? "approve" : "dismiss"));
  handle("taskBoard:get", (id: string) => engine.taskBoard(project(id)));
  handle("taskBoard:set", async (id: string, update: unknown) => { const r = await engine.setTaskBoard(project(id), sanitizeTaskBoardUpdate(update)); void pollOnce(); return r; });
  handle("usage", (id: string | null) => usage(id));
  handle("usage:localContext", (id: string) => { const p = project(id); return readLocalContext(agentForRole("implementation", p, agents()), store.data.clis, lastStatus.get(id)?.clineModel ?? null); });
  handle("skills:list", () => listSkills(engineDir, store.data.settings.skills.importedDirs));
  handle("skills:import", async () => {
    const result = await dialog.showOpenDialog(win!, { title: "Import skill folder (contains SKILL.md)", properties: ["openDirectory"] });
    if (!result.canceled) {
      const dir = result.filePaths[0];
      if (!store.data.settings.skills.importedDirs.includes(dir)) store.data.settings.skills.importedDirs.push(dir);
      await store.saveSettings();
    }
    return listSkills(engineDir, store.data.settings.skills.importedDirs);
  });
  handle("skills:libraries", () => TRUSTED_LIBRARIES.map(({ label, url }) => ({ label, url })));
  handle("skills:previewLibrary", (url: string, only?: string[]) => previewLibraryImport(String(url), undefined, Array.isArray(only) ? only.map(String) : undefined));
  handle("skills:installLibrary", async (token: string, names: string[]) => {
    if (!Array.isArray(names) || names.some((n) => typeof n !== "string")) throw new Error("Choose the skills to import.");
    const dirs = await installLibraryImport(String(token), names, path.join(store.dir, "skill-library"));
    for (const dir of dirs) if (!store.data.settings.skills.importedDirs.includes(dir)) store.data.settings.skills.importedDirs.push(dir);
    await store.saveSettings();
    return listSkills(engineDir, store.data.settings.skills.importedDirs);
  });
  handle("roles:list", () => roles.load());
  handle("roles:save", (role: Parameters<RolesService["save"]>[0]) => roles.save(role));
  handle("roles:delete", (id: string) => roles.remove(id));
  handle("roles:import", async () => {
    const result = await dialog.showOpenDialog(win!, { title: "Import workflow role (folder with ROLE.md)", properties: ["openDirectory"] });
    if (result.canceled) return { roles: roles.roles, imported: 0 };
    return roles.importFolder(result.filePaths[0]);
  });
  handle("limits:get", () => limits.state);
  handle("limits:refresh", (provider: "codex" | "claude") => limits.refresh(provider, true));
  handle("models:get", () => models.state);
  handle("models:refresh", (provider: "codex" | "claude") => models.refresh(provider));
  handle("update:status", () => updater.status);
  handle("update:check", () => updater.check(store.data.settings));
  handle("update:apply", () => applyUpdate());
  handle("shell:open", async (target: string) => {
    const roots = [
      ...store.data.projects.flatMap((p) => [p.path, p.stateDir]),
      // The Settings › Advanced folders: engine, configuration and app-managed project state.
      engineDir,
      store.dir,
      stateRoot,
      // Settings › Help: the bundled guides themselves (not the folder around them).
      ...Object.values(localDocs()),
      ...store.data.settings.skills.importedDirs,
      rolesDir,
    ];
    // Resolved once, then only that real path is checked and opened. A folder is shown, never opened:
    // between the check and the open it could be swapped for a program, which opening would run.
    let real: string;
    let isDirectory: boolean;
    try {
      real = realpathSync.native(String(target));
      isDirectory = statSync(real).isDirectory();
    } catch {
      return "That file or folder no longer exists.";
    }
    if (!canOpenPath(real, roots, isDirectory)) throw new Error("This path cannot be opened from Agent Dock.");
    if (isDirectory) {
      const first = readdirSync(real).sort()[0];
      shell.showItemInFolder(first ? path.join(real, first) : real);
      return "";
    }
    // "" when it opened; otherwise Windows' reason (no app for the file type).
    return shell.openPath(real);
  });
  handle("window", (action: "minimize" | "maximize" | "close") => {
    if (action === "minimize") win?.minimize();
    if (action === "maximize") (win?.isMaximized() ? win.unmaximize() : win?.maximize());
    if (action === "close") win?.close();
  });
}

// ---------- startup, resume-after-restart and quit ----------

async function resumeAfterRestart() {
  const mode = store.data.settings.workflow.resumeAfterRestart;
  for (const p of store.data.projects.filter((x) => !x.archived)) {
    const status = await engine.status(p).catch(() => null);
    const interrupted = status ? interruptedWork(status) : null;
    if (!interrupted) continue;
    if (mode === "auto") {
      await engine.control(p, "resume", await launchArgs(p), providerEnv(p)).catch((e) => notice({ kind: "error", message: `${p.name}: ${e.message}` }));
    } else if (mode === "ask") {
      // A notice, not a dialog: nothing blocks the launch; Resume on the project continues.
      notice({ kind: "warning", message: `${p.name}: the engine stopped during ${interrupted}. Press Resume to continue from the saved state.` });
    }
  }
}

// Task Scheduler starts a second copy with --scheduled-run while the app is open: run the due schedules instead of showing the window.
app.on("second-instance", (_event, argv) => {
  if (argv.includes(SCHEDULED_RUN_FLAG)) void runSchedules().catch(() => {});
  else showWindow();
});

app.on("before-quit", (event) => {
  if (quitting) return;
  const running = store.data.projects.filter((p) => engine.isAlive(p.id));
  if (!running.length) {
    quitting = true;
    return;
  }
  event.preventDefault();
  void dialog
    .showMessageBox({
      type: "warning",
      buttons: ["Keep running in background", "Stop at safe point", "Cancel"],
      defaultId: 0,
      cancelId: 2,
      title: "Automation is running",
      message: `${running.map((p) => p.name).join(", ")} ${running.length > 1 ? "are" : "is"} still running.`,
      detail: "The engine runs as its own process. Keeping it running is safe; reopen the app to reattach. Stop at safe point lets the current attempt finish first.",
    })
    .then(async ({ response }) => {
      if (response === 2) return;
      if (response === 1) for (const p of running) await engine.control(p, "stop", await launchArgs(p)).catch(() => {});
      quitting = true;
      app.quit();
    });
});

app.on("window-all-closed", () => {
  // Stay alive in the tray; quitting is explicit.
});

app.whenReady().then(async () => {
  const rendererDir = path.join(__dirname, "../renderer");
  protocol.handle(APP_SCHEME, (request) => {
    const file = resolveAppPath(rendererDir, request.url);
    return file ? net.fetch(pathToFileURL(file).toString()) : new Response("Not found", { status: 404 });
  });
  hardenSession(session.defaultSession);
  // On Linux Chromium downloads spellcheck dictionaries from Google (Windows and macOS use the OS's own): no requests the user did not ask for.
  if (process.platform === "linux") session.defaultSession.setSpellCheckerEnabled(false);
  // Packaged builds have no application menu (and so no reload or developer-tools shortcuts); text
  // fields keep their own copy, paste and undo keys without it.
  if (app.isPackaged) Menu.setApplicationMenu(null);
  await store.load();
  await roles.load();
  engineInfo = await engine.info();
  await loadLogKey();
  const resolveOrchestrator = async (kind: "codex" | "claude") => {
    const conn = store.data.clis.find((c) => c.kind === kind);
    return conn ? pickRunnable(await whereAll(conn.location)) : null;
  };
  limits = new LimitsService(path.join(store.dir, "limits.json"), resolveOrchestrator, (s) => send("limits", s), () => store.data.projects.filter((p) => !p.archived).map((p) => p.stateDir));
  await limits.load();
  models = new ModelsService(path.join(store.dir, "models.json"), resolveOrchestrator, (s) => send("models", s));
  await models.load();
  updater = new Updater(app.isPackaged, await Updater.readBuildInfo(app.getAppPath()), (s) => send("update", s), async () => pickRunnable(await whereAll("node")), Boolean(portable && !portable.updates), app.getVersion());
  const preferred = store.data.settings.general.defaultProject;
  if (preferred !== "last" && store.data.projects.some((p) => p.id === preferred && !p.archived)) store.data.settings.activeProjectId = preferred;
  if (store.fresh) {
    store.data.clis = await discoverClis([], systemProbes(whereAll));
    await store.saveClis();
  }
  if (!store.data.agents) {
    const found = foundTools(store.data.clis, await runningLocal(store.data.clis, systemProbes(whereAll)));
    const m = found.orchestrator ? engineInfo.orchestratorModels[found.orchestrator] : {};
    store.data.agents = defaultAgents({ qa: m.qa ?? "", assessment: m.assessment ?? "", elevate: m.elevate ?? "", reasoning: m.reasoning ?? "" }, found);
    await store.saveAgents();
  }
  stopAllPath = await writeStopLauncher().catch((error) => { console.error("Stop-all launcher not written", error); return ""; });
  registerIpc();
  createWindow();
  createTray();
  startPolling();
  startCiPolling();
  void startApprovals().catch((error) => console.error("Remote approvals not started", error));
  void checkAllClis();
  setTimeout(() => void resumeAfterRestart(), 2500);
  setTimeout(() => void checkForUpdatesOnLaunch(), 4000);
  setTimeout(() => limits.schedule(store.data.settings), 3000);
  setInterval(() => void runSchedules().catch(() => {}), 60_000);
  setInterval(() => void checkIntegrity().catch((error) => console.error("Integrity check failed", error)), 3_000);
  // Launched by Task Scheduler: start what is due once the app is ready, then keep checking as usual.
  if (process.argv.includes(SCHEDULED_RUN_FLAG)) setTimeout(() => void runSchedules().catch(() => {}), 5000);
  if (store.data.projects.some((p) => p.schedule?.whenClosed)) setTimeout(() => void syncWindowsSchedules().catch(() => {}), 8000);
  // Model lists are free to read; refresh once a day or when missing.
  setTimeout(() => void models.refreshStale(24 * 60 * 60_000), 6000);
});
