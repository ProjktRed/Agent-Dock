import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ProjectStatus } from "@shared/types";
import { cleanError, useApp, type Route } from "../store";
import { plural, runTone } from "../lib/format";
import { Icon, type IconName } from "./Icon";
import { Dot, Modal } from "./ui";
import { useUpdateStatus } from "../lib/updates";
import { openSettingsSection } from "../lib/nav";
import { Logo } from "./Logo";
import { MaxLimitsDialog, useMaxModeOn } from "./TaskMode";

/** Bring the attention card into view: Overview switches to its Progress tab, then the card scrolls in. */
function showAttentionPanel() {
  window.dispatchEvent(new Event("app:show-attention"));
  setTimeout(() => {
    const panel = document.getElementById("attention-panel");
    panel?.scrollIntoView({ behavior: "smooth", block: "center" });
    panel?.classList.remove("flash");
    void panel?.offsetWidth;
    panel?.classList.add("flash");
  }, 120);
}

const NAV: { route: Route; label: string; icon: IconName }[] = [
  { route: "overview", label: "Overview", icon: "overview" },
  { route: "projects", label: "Projects", icon: "folder" },
  { route: "workflow", label: "Workflow", icon: "workflow" },
  { route: "agents", label: "Agents", icon: "agent" },
  { route: "clis", label: "CLIs", icon: "terminal" },
  { route: "settings", label: "Settings", icon: "settings" },
];

export function Sidebar() {
  const { route, go, collapsed, setCollapsed, snap, statuses, healths } = useApp();
  const projects = snap.projects.filter((p) => !p.archived);
  const attention = Object.values(statuses).filter((s) => ["attention", "blocked"].includes(s.runState)).length;
  const healthList = Object.values(healths);
  const unhealthy = healthList.filter((h) => h.state !== "connected").length;
  const healthy = healthList.length - unhealthy;
  const maxMode = useMaxModeOn();
  const [maxOpen, setMaxOpen] = useState(false);
  const badges: Partial<Record<Route, ReactNode>> = {
    overview: attention ? <span className="badge lbl attn">{attention}</span> : null,
    projects: projects.length ? <span className="badge lbl">{projects.length}</span> : null,
    clis: unhealthy ? <span className="badge lbl err">{unhealthy}</span> : null,
  };
  return (
    <nav className={`side ${collapsed ? "collapsed" : ""}`} aria-label="Primary">
      {NAV.map((n) => (
        <button key={n.route} className={`nav ${route === n.route ? "on" : ""}`} aria-current={route === n.route ? "page" : undefined} title={n.label} onClick={() => go(n.route)}>
          <Icon name={n.icon} />
          <span className="lbl">{n.label}</span>
          {badges[n.route]}
        </button>
      ))}
      <div className="grow" />
      <div className="sidefoot lbl">
        <span className="row" style={{ gap: 6 }}>
          <Dot tone={Object.values(statuses).some((s) => s.processAlive) ? "ok" : "mut"} />
          {plural(Object.values(statuses).filter((s) => s.processAlive).length, "engine")} running
        </span>
        <span>{healthList.length ? `${healthy} of ${healthList.length} CLIs healthy` : "Checking CLIs…"}</span>
      </div>
      {maxMode && (
        <button className="nav" onClick={() => setMaxOpen(true)} title="Max limits: Max mode's own task limits">
          <Icon name="warn" className="warn" />
          <span className="lbl">Max limits</span>
        </button>
      )}
      {maxOpen && <MaxLimitsDialog onClose={() => setMaxOpen(false)} />}
      <button className="nav" onClick={() => setCollapsed(!collapsed)} aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} title="Toggle sidebar (Ctrl+B)">
        <Icon name="sidebar" />
        <span className="lbl">Collapse</span>
      </button>
    </nav>
  );
}

function ProjectSelector() {
  const { snap, activeProject, setActive, statuses, go } = useApp();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, []);
  const projects = snap.projects.filter((p) => !p.archived);
  return (
    <div className="rel" ref={ref}>
      <button className={`projsel ${open ? "open" : ""}`} onClick={() => setOpen(!open)} aria-haspopup="listbox" aria-expanded={open} disabled={!projects.length} aria-label="Active project">
        <Icon name="folder" size="sm" className="mut" />
        <span className="nm">{activeProject?.name ?? "No project"}</span>
        {activeProject && statuses[activeProject.id]?.git.branch && <span className="mut mono" style={{ fontSize: 11 }}>{statuses[activeProject.id].git.branch}</span>}
        <Icon name="chevronDown" size="sm" className="mut" />
      </button>
      {open && (
        <div className="menu fade-in" role="listbox" aria-label="Projects">
          <div className="menu-h">Switch active project</div>
          {projects.map((p) => {
            const s = statuses[p.id];
            return (
              <button
                key={p.id}
                className={`menu-i ${p.id === activeProject?.id ? "on" : ""}`}
                role="option"
                aria-selected={p.id === activeProject?.id}
                onClick={() => {
                  void setActive(p.id);
                  setOpen(false);
                }}
              >
                <Dot tone={s ? runTone[s.runState].dot : "mut"} />
                <span className="grow ellipsis">{p.name}</span>
                <span className="mut" style={{ fontSize: 11.5 }}>{s?.label ?? ""}</span>
              </button>
            );
          })}
          <div className="menu-sep" />
          <button className="menu-i" onClick={() => { go("projects"); setOpen(false); }}>
            <Icon name="plus" size="sm" className="mut" />
            <span className="grow">Manage or add projects…</span>
          </button>
        </div>
      )}
    </div>
  );
}

function PromptBar() {
  const { activeProject, activeStatus, saveProject, control, toast, promptOpen, setPromptOpen, snap } = useApp();
  const [text, setText] = useState("");
  const [taskFile, setTaskFile] = useState<string | null>(null);
  const [target, setTarget] = useState(activeProject?.id ?? "");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (promptOpen) {
      setText(activeProject?.objective ?? "");
      setTarget(activeProject?.id ?? "");
      setTaskFile(activeProject?.pendingTaskFile ?? null);
    }
  }, [promptOpen, activeProject]);
  useEffect(() => {
    const close = (e: MouseEvent) => promptOpen && !ref.current?.contains(e.target as Node) && setPromptOpen(false);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [promptOpen, setPromptOpen]);
  const projects = snap.projects.filter((p) => !p.archived);
  const project = projects.find((p) => p.id === target) ?? activeProject;
  const alive = activeStatus?.processAlive && project?.id === activeProject?.id;

  const submit = async (start: boolean) => {
    if (!project) return toast("warning", "Add a project first.");
    if (!text.trim()) return toast("warning", "Write an objective for the automation.");
    try {
      await saveProject({ ...project, objective: text.trim(), pendingTaskFile: taskFile });
      setPromptOpen(false);
      if (start) await control(project.id, "start", `Automation started on ${project.name}`);
      else toast("success", alive ? "Objective saved. The running engine keeps its current objective until it is restarted." : "Objective saved");
    } catch (error) {
      toast("error", cleanError(error));
    }
  };

  return (
    <div className="rel" ref={ref}>
      <button className="prompt" onClick={() => setPromptOpen(!promptOpen)} aria-label="Open automation prompt" aria-expanded={promptOpen} disabled={!projects.length} title="Automation prompt (Ctrl+K)">
        <Icon name="prompt" size="sm" />
        <span className="ph">{activeProject?.objective || (projects.length ? "Describe the objective for this project…" : "Add a project to start automating")}</span>
        <span className="kbd">Ctrl K</span>
      </button>
      {promptOpen && (
        <div className="pop fade-in" role="dialog" aria-label="Automation prompt">
          <label className="sr" htmlFor="prompt-text">Objective</label>
          <textarea
            id="prompt-text"
            className="ta"
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && e.ctrlKey) void submit(!alive);
            }}
            placeholder="A bounded objective, e.g. Add per-route overrides to the rate limiter config and cover them with tests"
          />
          <div className="row wrap" style={{ gap: 12 }}>
            <label className="row" style={{ gap: 6 }}>
              <span className="sub">Project</span>
              <select className="sel" value={target} onChange={(e) => setTarget(e.target.value)}>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </label>
            <span className="sub" data-tip="The engine always runs the full cycle: Assessment plans a bounded task, the Implementation agent makes the change, QA verifies and commits. Single-agent runs are not supported by the engine.">Runs the full workflow</span>
            <button className="btn sm" onClick={async () => setTaskFile(await window.api.pickTaskFile())} title="Optional first task (JSON with id, prompt, qaCommand, allowedPaths)">
              <Icon name="clip" size="sm" />
              {taskFile ? taskFile.split(/[\\/]/).pop() : "Attach task file"}
            </button>
            {taskFile && <button className="btn ghost sm" onClick={() => setTaskFile(null)}>Remove</button>}
          </div>
          <div className="row" style={{ gap: 10 }}>
            <span className="sub grow">{alive ? "The engine is running. Saving updates the objective used on the next start." : "Ctrl+Enter starts the automation."}</span>
            <button className="btn ghost sm" onClick={() => setPromptOpen(false)}>Cancel</button>
            <button className="btn sm" onClick={() => void submit(false)}>Save objective</button>
            {!alive && <button className="btn primary sm" onClick={() => void submit(true)}>Start</button>}
          </div>
        </div>
      )}
    </div>
  );
}

export function RunControls({ status, projectId, size = "sm" }: { status: ProjectStatus | null; projectId: string | null; size?: "sm" | "" }) {
  const { control, go } = useApp();
  const [stopOpen, setStopOpen] = useState(false);
  if (!projectId) return null;
  const s = status;
  const alive = Boolean(s?.processAlive);
  const state = s?.runState ?? "idle";
  const btn = `btn ${size}`;
  const buttons: ReactNode[] = [];
  if (alive && state === "running") buttons.push(<button key="p" className={btn} onClick={() => control(projectId, "pause", "Will pause after the current task")} title="Pause after the current task (Ctrl+Shift+P)"><Icon name="pause" size="sm" />Pause</button>);
  if (alive && state === "pausing") buttons.push(<button key="cp" className={btn} onClick={() => control(projectId, "resume")}>Cancel pause</button>);
  if (alive && state === "stopping") buttons.push(<button key="kr" className={btn} onClick={() => control(projectId, "resume")}>Keep running</button>);
  if (state === "paused" || (!alive && ["stopped", "waiting-limit"].includes(state)) || (alive && state === "waiting-limit"))
    buttons.push(<button key="r" className={`${btn} primary`} onClick={() => control(projectId, "resume", "Resumed")} title="Resume (Ctrl+Shift+P)"><Icon name="play" size="sm" />Resume</button>);
  if (!alive && ["idle", "complete"].includes(state)) buttons.push(<button key="s" className={`${btn} primary`} onClick={() => control(projectId, "start", "Automation started")} title="Run (F5)"><Icon name="play" size="sm" />Run</button>);
  if (["attention", "blocked"].includes(state)) buttons.push(<button key="ra" className={`${btn} primary`} onClick={() => { go("overview"); showAttentionPanel(); }}>Resolve attention</button>);
  if (alive) buttons.push(<button key="x" className={`${btn} icon`} onClick={() => setStopOpen(true)} aria-label="Stop automation" title="Stop… (Shift+F5)"><Icon name="stop" size="sm" className="err" /></button>);
  return (
    <div className="row" style={{ gap: 10 }}>
      {buttons}
      {stopOpen && (
        <Modal label="Stop automation" onClose={() => setStopOpen(false)}>
          <div>
            <h2 className="h2">Stop automation?</h2>
            <p className="sub" style={{ margin: "6px 0 0" }}>Uncommitted changes stay in the working tree in every case. Nothing is reset or deleted.</p>
          </div>
          <button className="opt" onClick={() => { setStopOpen(false); void control(projectId, "stop-after-task", "Will stop once the current task finishes"); }}>
            <span className="st pending" style={{ marginTop: 2 }} />
            <span><b style={{ fontWeight: 600, display: "block" }}>Stop after current task</b><span className="sub">Finish the task in progress (including QA), then exit.</span></span>
          </button>
          <button className="opt" onClick={() => { setStopOpen(false); void control(projectId, "stop", "Will stop at the next safe point"); }}>
            <span className="st paused" style={{ marginTop: 2 }} />
            <span><b style={{ fontWeight: 600, display: "block" }}>Stop at next safe point</b><span className="sub">Let the current implementation attempt or QA run reach a safe boundary, then exit.</span></span>
          </button>
          <button className="opt" onClick={() => { setStopOpen(false); void control(projectId, "stop-now", "Engine process terminated"); }}>
            <span className="st blocked" style={{ marginTop: 2 }} />
            <span><b className="err" style={{ fontWeight: 600, display: "block" }}>Stop now</b><span className="sub">Terminates the engine and its CLI child processes immediately. The engine recovers from its saved state on the next start.</span></span>
          </button>
          <div className="row"><span className="grow" /><button className="btn ghost" onClick={() => setStopOpen(false)}>Cancel</button></div>
        </Modal>
      )}
    </div>
  );
}

/** In-app replacement for the old "Update available" dialog; lives in the empty middle of the title bar. */
function UpdateNotice() {
  const { go, toast } = useApp();
  const update = useUpdateStatus();
  const [dismissed, setDismissed] = useState<string | null>(null);
  if (!update?.latest || !["available", "building", "ready"].includes(update.state)) return null;
  const available = update.state === "available";
  if (available && dismissed === update.latest.commit) return null;
  const n = update.commits.length;
  const version = update.latest.version ? `v${update.latest.version}` : update.latest.commit.slice(0, 7);
  const details = () => {
    openSettingsSection("updates");
    go("settings");
  };
  return (
    <div className="updnote fade-in" role="status" title={update.commits.slice(0, 8).map((c) => `${c.hash.slice(0, 7)} ${c.subject}`).join("\n")}>
      <Dot tone="attn" live={!available} />
      {available ? (
        <>
          <button className="updlink ellipsis" onClick={details} aria-label={`Update ${version} available, ${n || "new"} commit${n === 1 ? "" : "s"}. Open details`}>
            <b>Update {version}</b><span className="mut opt-word"> available</span>
          </button>
          <button className="btn primary sm" onClick={() => window.api.applyUpdate().catch((e) => toast("error", cleanError(e)))}>Update now</button>
          <button className="btn ghost sm icon" onClick={() => setDismissed(update.latest!.commit)} aria-label="Later" title="Later"><Icon name="close" size="sm" /></button>
        </>
      ) : (
        <>
          <button className="updlink ellipsis" onClick={details} title="Open the update log">
            <b>{update.state === "ready" ? "Restarting to update…" : `Building ${version}…`}</b>
          </button>
        </>
      )}
    </div>
  );
}

export function TitleBar() {
  const { activeProject, activeStatus } = useApp();
  const state = activeStatus?.runState ?? "idle";
  const tone = runTone[state];
  return (
    <header className="titlebar">
      <div className="brand">
        <Logo size={24} />
        <span>Agent Dock</span>
      </div>
      <ProjectSelector />
      <PromptBar />
      <div className="grow drag titlecenter">
        <UpdateNotice />
      </div>
      {activeProject && (
        <span className={`pill ${["attention", "blocked"].includes(state) ? "attn" : ""}`} role="status">
          <Dot tone={tone.dot} live={tone.live && activeStatus?.processAlive} />
          <span className="lbl2">{activeStatus?.label ?? "Loading…"}</span>
        </span>
      )}
      <RunControls status={activeStatus} projectId={activeProject?.id ?? null} />
      <div className="wcs">
        <button className="wc" aria-label="Minimize" onClick={() => window.api.windowControl("minimize")}><Icon name="min" /></button>
        <button className="wc" aria-label="Maximize" onClick={() => window.api.windowControl("maximize")}><Icon name="max" /></button>
        <button className="wc close" aria-label="Close" onClick={() => window.api.windowControl("close")}><Icon name="close" /></button>
      </div>
    </header>
  );
}

export function StatusBar() {
  const { activeStatus, snap, go } = useApp();
  const update = useUpdateStatus();
  return (
    <footer className="statusbar">
      <span className="row" style={{ gap: 6 }}>
        <Dot tone={activeStatus?.processAlive ? "ok" : "mut"} />
        {activeStatus?.processAlive ? `Engine running · pid ${activeStatus.pid}` : "Engine idle"}
      </span>
      {activeStatus?.git.isRepo && (
        <span>
          Git: {activeStatus.git.branch} · {activeStatus.git.changedFiles.length ? `${activeStatus.git.changedFiles.length} changed` : "clean"}
          {activeStatus.git.head ? ` · ${activeStatus.git.head.slice(0, 7)}` : ""}
        </span>
      )}
      <span className="grow" />
      <button className="linkish mono" title={`Agent Dock ${snap.version} · engine: ${snap.engine.dir}\nOpen Settings › Updates`} onClick={() => { openSettingsSection("updates"); go("settings"); }}>
        Agent Dock v{snap.version}
      </button>
      <span className="mono" title={update?.installed ? `${update.installed.subject} · built ${update.installed.builtAt}` : "Development build"}>
        {update?.installed ? update.installed.shortCommit : "dev"}
      </span>
    </footer>
  );
}

export function Toasts() {
  const { toasts, dismissToast } = useApp();
  const icon = { success: "done", warning: "attn", error: "blocked", info: "active" } as const;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className="toast fade-in">
          <span className={`st ${icon[t.kind]}`} />
          <span className="grow">{t.message}</span>
          <button className="btn ghost sm icon" onClick={() => dismissToast(t.id)} aria-label="Dismiss"><Icon name="close" size="sm" /></button>
        </div>
      ))}
    </div>
  );
}
