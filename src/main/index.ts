import path from "node:path";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, session, shell, Tray } from "electron";
import type { ControlAction, LaunchCheck, Notice } from "@shared/api";
import type { AddProjectRequest, Agent, CliConnection, CliHealth, EngineInfo, NotifyChannel, Project, ProjectStatus, Settings, SkillInfo, TokenRecord, UsageSummary } from "@shared/types";
import { defaultAgents } from "./defaults";
import { EngineManager } from "./engine";
import { appIcon } from "./icon";
import { checkCli, detectOnPath, pickRunnable, whereAll } from "./lib/clis";
import { agentForRole, buildEngineArgs } from "./lib/engine-args";
import { isCompactionDone } from "./lib/usage";
import { RemoteApprovals, type ApprovalAction, type EmailChannel, type TelegramChannel } from "./lib/remote-approvals";
import { countCompactions, implementationUsage, readActivity, readOrchestratorUsage } from "./lib/usage";
import { addProject, inspectDirectory, taskHistory } from "./projects";
import { AUTO_INDEX_MAX, listSkills, ROLE_SKILLS_MAX_CHARS, SKILL_MAX_CHARS, skillDeliveryText } from "./skills";
import { installLibraryImport, previewLibraryImport, TRUSTED_LIBRARIES } from "./skill-library";
import { generatePlan, PLANNER_KINDS, savePlan } from "./planner";
import { RolesService } from "./roles";
import { AppStore } from "./store";
import { ownerFixCommand, sharedGitOwnerProblem } from "./lib/git";
import { canOpenPath, isExternalWebUrl } from "./lib/safe-open";
import { interruptedWork } from "./lib/status";
import { Updater } from "./updater";
import { LimitsService } from "./limits";
import { ModelsService } from "./models";
import { collectLlamaCpp, collectOllama, detectLlamaModelsDir, readLocalContext } from "./local-models";
import {assertSafeLaunch,hardenSession,hardenWebContents} from './lib/security';
import { stopLauncher } from "./lib/stop-launcher";

try {
  assertSafeLaunch(app.isPackaged,[...process.argv,...process.execArgv,...['remote-debugging-port','remote-debugging-pipe','inspect','inspect-brk','inspect-port'].filter(flag=>app.commandLine.hasSwitch(flag)).map(flag=>'--'+flag)]);
} catch(error) {
  console.error((error as Error).message);
  app.exit(64);
}
app.on('web-contents-created',(_event,contents)=>hardenWebContents(contents));
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

const engine = new EngineManager(engineDir, resolveNode);
let updater: Updater;
let limits: LimitsService;
let models: ModelsService;

async function applyUpdate() {
  const running = store.data.projects.filter((p) => engine.isAlive(p.id));
  if (running.length) throw new Error(`Stop the automation first (${running.map((p) => p.name).join(", ")}). Updating replaces the engine files.`);
  await updater.apply(store.data.settings, () => {
    quitting = true;
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
  return buildEngineArgs({ project: p, agents: agents(), clis: store.data.clis, settings: store.data.settings, roles: roles.roles, protectedRoots: [store.dir, engineDir, ...(app.isPackaged ? [path.dirname(process.execPath)] : [])] });
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
      if (skill.instructions.length > SKILL_MAX_CHARS) throw new Error(`Skill “${name}” is longer than ${SKILL_MAX_CHARS.toLocaleString()} characters; shorten its SKILL.md or unassign it.`);
      roles[role].push({ name, instructions: (await skillDeliveryText(skill)).text });
    }
    const total = roles[role].reduce((sum, s) => sum + s.instructions.length, 0);
    if (total > ROLE_SKILLS_MAX_CHARS) throw new Error(`Skills assigned to ${role} are longer than ${ROLE_SKILLS_MAX_CHARS.toLocaleString()} characters in total; unassign some.`);
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

function providerEnv(p: Project): NodeJS.ProcessEnv {
  const impl = agentForRole("implementation", p, agents());
  if (!impl || impl.provider !== "openai") return notifyEnv(p);
  const selected = impl.providerCliId ? store.data.clis.find((c) => c.id === impl.providerCliId) : undefined;
  const provider = selected
    ? selected.kind === "openai" ? selected : undefined
    : store.data.clis.find((c) => c.kind === "openai");
  const secret = provider ? store.getSecret(provider.id) : null;
  return { ...notifyEnv(p), ...(secret ? { AGENT_DOCK_PROVIDER_KEY: secret } : {}) };
}

/** A control request from the app's buttons or a remote approval (source names who asked, for the action log). */
async function runControl(id: string, action: ControlAction, source = "app") {
  const p = project(id);
  const check = launchCheck(p);
  const starting = ["start", "resume", "resolve", "retry-qa"].includes(action) && !engine.isAlive(id);
  if (starting && check.problems.length) throw new Error(check.problems.join(" "));
  if (starting && check.warnings.length) notice({ kind: "warning", message: check.warnings.join(" ") });
  // QA commits in the repository's shared .git; Codex's Windows sandbox can only prepare it when the user owns it.
  if (starting) {
    const owner = await sharedGitOwnerProblem(p.path).catch(() => null);
    if (owner) {
      const message = `QA cannot commit in ${p.name}: ${owner.dir} belongs to ${owner.owner}, not ${owner.user}. In an Administrator PowerShell run: ${ownerFixCommand(owner)}`;
      if (action === "retry-qa") throw new Error(message);
      notice({ kind: "warning", message });
    }
  }
  const wasAlive = engine.isAlive(id);
  await engine.control(p, action, await launchArgs(p, check), providerEnv(p), source);
  if (p.pendingTaskFile && !wasAlive && engine.isAlive(id)) {
    // The attached task is a one-shot first task.
    store.data.projects = store.data.projects.map((x) => (x.id === id ? { ...x, pendingTaskFile: null } : x));
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
      if (settings.general.notifyCompleted) osNotify(`Task approved · ${p.name}`, `${event.taskId ?? "Task"} passed QA after ${event.attempt ?? "?"} attempt(s).`);
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
}

const lastSent = new Map<string, string>();

async function pollOnce() {
  const active = store.data.settings.activeProjectId;
  for (const p of store.data.projects) {
    if (p.archived) continue;
    if (p.id !== active && !engine.isAlive(p.id) && lastStatus.has(p.id)) continue;
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
      const result = await checkCli(c, store.getSecret(c.id));
      health.set(c.id, result);
      send("health", result);
    }),
  );
}

// ---------- window and tray ----------

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 620,
    frame: false,
    backgroundColor: "#152131",
    show: false,
    icon: appIcon(256),
    title: "Agent Dock",
    webPreferences: { preload: path.join(__dirname, "../preload/index.js"), sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false },
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
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(path.join(__dirname, "../renderer/index.html"));
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
  await writeFile(launcher.file, launcher.content, { mode: 0o755 });
  return launcher.file;
}
let stopAllPath = "";

// ---------- IPC ----------

function snapshot() {
  return { projects: store.data.projects, agents: agents(), clis: store.data.clis.map((c) => ({ ...c, hasSecret: store.hasSecret(c.id) })), settings: store.data.settings, engine: engineInfo, roles: roles.roles, paths: { config: store.dir, projectState: stateRoot, stopAll: stopAllPath }, notifyChannels: Object.fromEntries(NOTIFY_CHANNELS.map((k) => [k, store.hasSecret(`notify:${k}`)])) as Record<NotifyChannel, boolean>, notifyDetails: notifyDetails(), version: app.getVersion() };
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

function registerIpc() {
  const handle = (channel: string, fn: (...args: any[]) => unknown) =>
    ipcMain.handle(channel, (event, ...args) => {
      // Only the app's own window may call into the main process.
      if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error("IPC sender not allowed");
      return fn(...args);
    });

  handle("snapshot", snapshot);
  handle("settings:save", async (settings: Settings) => {
    const previous = store.data.settings.usage;
    const previousUpdates = store.data.settings.updates;
    store.data.settings = settings;
    await store.saveSettings();
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
    const i = store.data.clis.findIndex((c) => c.id === cli.id);
    store.data.clis = i >= 0 ? store.data.clis.map((c) => (c.id === cli.id ? cli : c)) : [...store.data.clis, cli];
    if (secret !== undefined) await store.setSecret(cli.id, secret);
    await store.saveClis();
    return snapshot().clis;
  });
  handle("cli:collectModels", async (id: string) => {
    const conn = store.data.clis.find((c) => c.id === id);
    if (!conn) throw new Error("Connection not found");
    if (conn.kind !== "llamacpp" && conn.kind !== "ollama") throw new Error("Only local providers list models here");
    const collected = conn.kind === "ollama" ? await collectOllama(conn.location.replace(/\/$/, "")) : await collectLlamaCpp(conn, store.data.settings.advanced.llamaCppLauncher);
    store.data.clis = store.data.clis.map((c) => (c.id === id ? { ...c, collected } : c));
    await store.saveClis();
    return snapshot().clis;
  });
  handle("cli:detectModelsDir", () => detectLlamaModelsDir(store.data.settings.advanced.llamaCppLauncher));
  handle("cli:delete", async (id: string) => {
    store.data.clis = store.data.clis.filter((c) => c.id !== id || c.builtIn);
    await store.setSecret(id, null);
    await store.saveClis();
    return snapshot().clis;
  });
  handle("cli:check", async (id: string) => {
    const conn = store.data.clis.find((c) => c.id === id);
    if (!conn) throw new Error("Connection not found");
    const result = await checkCli(conn, store.getSecret(id));
    health.set(id, result);
    send("health", result);
    return result;
  });
  handle("cli:healths", () => [...health.values()]);
  handle("cli:test", (cli: CliConnection, secret?: string | null) => checkCli(cli, secret ?? store.getSecret(cli.id)));
  handle("cli:detect", (command: string) => detectOnPath(command));
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
      return await generatePlan(p.path, p.objective, { connection, model: model?.trim() || null, apiKey: connection.kind === "openai" ? store.getSecret(connection.id) : null }, controller.signal);
    } finally {
      if (planners.get(projectId) === controller) planners.delete(projectId);
    }
  });
  handle("planner:cancel", (projectId: string) => { planners.get(projectId)?.abort(); });
  handle("planner:save", (projectId: string, text: string) => savePlan(project(projectId).path, String(text)));
  handle("project:update", async (p: Project) => {
    store.data.projects = store.data.projects.map((x) => (x.id === p.id ? p : x));
    await store.saveProjects();
    return store.data.projects;
  });
  handle("project:remove", async (id: string, deleteHistory: boolean) => {
    const p = project(id);
    if (engine.isAlive(id)) throw new Error("Stop the automation for this project before removing it.");
    store.data.projects = store.data.projects.filter((x) => x.id !== id);
    if (store.data.settings.activeProjectId === id) store.data.settings.activeProjectId = store.data.projects.find((x) => !x.archived)?.id ?? null;
    await Promise.all([store.saveProjects(), store.saveSettings()]);
    // Only ever delete app-managed engine state, never the workspace or a user-chosen state folder.
    if (deleteHistory && path.resolve(p.stateDir).startsWith(path.resolve(stateRoot))) await rm(path.dirname(p.stateDir), { recursive: true, force: true });
    lastStatus.delete(id);
    return store.data.projects;
  });
  handle("project:activate", async (id: string | null) => {
    store.data.settings.activeProjectId = id;
    await store.saveSettings();
    void pollOnce();
  });
  handle("project:history", async (id: string) => taskHistory(await readActivity(project(id).stateDir, 20_000)));
  handle("project:gitOwner", async (id: string) => {
    const problem = await sharedGitOwnerProblem(project(id).path);
    return problem ? { ...problem, command: ownerFixCommand(problem) } : null;
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
    try { const r = await engine.verifyActionLog(p); return { project: p.name, ok: r.ok, entries: r.entries, lastAt: r.lastAt, brokenAt: r.brokenAt, reason: r.reason }; }
    catch (error) { return { project: p.name, ok: false, entries: 0, lastAt: null, reason: (error as Error).message }; }
  })));
  handle("plan:proposals", (id: string) => engine.planProposals(project(id)));
  handle("project:runs", (id: string) => engine.runs(project(id)));
  handle("plan:decide", (id: string, proposalId: string, decision: "approve" | "dismiss") => engine.decidePlanProposal(project(id), proposalId, decision === "approve" ? "approve" : "dismiss"));
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
      ...store.data.settings.skills.importedDirs,
      rolesDir,
    ];
    let isDirectory = false;
    try {
      isDirectory = statSync(target).isDirectory();
    } catch {
      // missing target: shell.openPath reports it
    }
    if (!canOpenPath(target, roots, isDirectory)) throw new Error("This path cannot be opened from Agent Dock.");
    await shell.openPath(target);
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

app.on("second-instance", showWindow);

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
  hardenSession(session.defaultSession);
  await store.load();
  await roles.load();
  engineInfo = await engine.info();
  const resolveOrchestrator = async (kind: "codex" | "claude") => {
    const conn = store.data.clis.find((c) => c.kind === kind);
    return conn ? pickRunnable(await whereAll(conn.location)) : null;
  };
  limits = new LimitsService(path.join(store.dir, "limits.json"), resolveOrchestrator, (s) => send("limits", s));
  await limits.load();
  models = new ModelsService(path.join(store.dir, "models.json"), resolveOrchestrator, (s) => send("models", s));
  await models.load();
  updater = new Updater(app.isPackaged, await Updater.readBuildInfo(app.getAppPath()), (s) => send("update", s), async () => pickRunnable(await whereAll("node")), Boolean(portable && !portable.updates), app.getVersion());
  const preferred = store.data.settings.general.defaultProject;
  if (preferred !== "last" && store.data.projects.some((p) => p.id === preferred && !p.archived)) store.data.settings.activeProjectId = preferred;
  if (!store.data.agents) {
    const m = engineInfo.orchestratorModels.codex;
    store.data.agents = defaultAgents({ qa: m.qa ?? "", assessment: m.assessment ?? "", elevate: m.elevate ?? "", reasoning: m.reasoning ?? "" });
    await store.saveAgents();
  }
  stopAllPath = await writeStopLauncher().catch((error) => { console.error("Stop-all launcher not written", error); return ""; });
  registerIpc();
  createWindow();
  createTray();
  startPolling();
  void startApprovals().catch((error) => console.error("Remote approvals not started", error));
  void checkAllClis();
  setTimeout(() => void resumeAfterRestart(), 2500);
  setTimeout(() => void checkForUpdatesOnLaunch(), 4000);
  setTimeout(() => limits.schedule(store.data.settings), 3000);
  // Model lists are free to read; refresh once a day or when missing.
  setTimeout(() => void models.refreshStale(24 * 60 * 60_000), 6000);
});
