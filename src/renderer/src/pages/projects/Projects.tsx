import { useEffect, useState } from "react";
import { describeSchedule, SCHEDULE_GRACE_MINUTES, scheduleMinutes } from "@shared/schedule";
import type { HistoryEntry } from "@shared/api";
import type { CiCheck, CiState, CiStatus, Project, ProjectSchedule, WorkflowSettings } from "@shared/types";
import { CI_FIX_MAX } from "@shared/ci";
import { cleanError, useApp } from "../../store";
import { ago, longDate, plural, runTone } from "../../lib/format";
import { agentForRoleClient } from "../../lib/agents";
import { Icon } from "../../components/Icon";
import { Bar, Dot, Empty, Modal, St, Support, Tabs, Toggle, type StatusKind } from "../../components/ui";
import { AddProjectDialog } from "./AddProjectDialog";
import { TaskModePicker } from "../../components/TaskMode";
import { TASK_MODES, taskModeOf } from "@shared/task-mode";

type DetailTab = "overview" | "plan" | "agents" | "workflow" | "history";
const ROLES = [
  ["implementation", "Implementation"],
  ["qa", "QA"],
  ["assessment", "Assessment"],
  ["elevation", "Elevation"],
] as const;

function WorkflowTab({ project }: { project: Project }) {
  const { snap, saveProject } = useApp();
  const global = snap.settings.workflow;
  const rows: { key: keyof WorkflowSettings; label: string; desc: string; support: "engine" | "app" }[] = [
    { key: "autoContinue", label: "Automatic continuation", desc: "Start the next task as soon as one is approved. Off: pause at each task boundary.", support: "app" },
    { key: "automaticElevation", label: "Automatic elevation", desc: "One automatic Elevation reassessment on a manual-review case (--sol-reassessment)", support: "engine" },
    { key: "toolGuard", label: "Worker tool guard", desc: "Restrict Cline and OpenCode to approved tools, paths and commands (--tool-guard)", support: "engine" },
  ];
  const set = (key: keyof WorkflowSettings, value: boolean | undefined) => {
    const next = { ...project.workflowOverrides } as Record<string, unknown>;
    if (value === undefined) delete next[key];
    else next[key] = value;
    void saveProject({ ...project, workflowOverrides: next as Partial<WorkflowSettings> });
  };
  return (
    <div className="fade-in">
      {rows.map((r) => {
        const overridden = r.key in project.workflowOverrides;
        const value = (overridden ? project.workflowOverrides[r.key] : global[r.key]) as boolean;
        return (
          <div className="setrow" key={r.key}>
            <div className="grow"><div className="lt row" style={{ gap: 8 }}>{r.label}<Support kind={r.support} /></div><div className="ld">{r.desc}</div></div>
            <ScopeChip overridden={overridden} onReset={() => set(r.key, undefined)} />
            <Toggle on={value} onChange={(v) => set(r.key, v)} label={r.label} />
          </div>
        );
      })}
      <TaskModeRow project={project} />
      <ParallelRow project={project} />
      <ParallelCleanupRow project={project} />
      <ScheduleRow project={project} />
      <PullRequestRow project={project} />
      <CiRow project={project} />
      {!project.parentId && <LanesRow project={project} />}
      <WslRow project={project} />
      <div className="setrow">
        <div className="grow"><div className="lt row" style={{ gap: 8 }}>Engine state folder<Support kind="engine" /></div><div className="ld mono">{project.stateDir}</div></div>
        <button className="btn sm" onClick={() => window.api.openPath(project.stateDir)}>Open</button>
      </div>
    </div>
  );
}

/**
 * Where a Workflow row's value comes from, shown on every setting row: inherited from Settings › Workflow rules,
 * a project override (with Reset), or a setting that exists only per project (no onReset).
 */
function ScopeChip({ overridden = false, onReset }: { overridden?: boolean; onReset?: () => void }) {
  if (!onReset) return <span className="chip mut dash" title="Set per project; there is no global default in Settings">This project</span>;
  return (
    <>
      <span className={`chip ${overridden ? "lav" : "mut"}`} title={overridden ? "Overrides Settings › Workflow rules for this project" : "Follows Settings › Workflow rules"}>{overridden ? "Project override" : "Inherited"}</span>
      {overridden && <button className="btn ghost sm" onClick={onReset}>Reset</button>}
    </>
  );
}

/** This project's task size: inherited from Settings › Workflow rules, or its own. */
function TaskModeRow({ project }: { project: Project }) {
  const { snap, saveProject } = useApp();
  const overridden = project.workflowOverrides.taskMode !== undefined;
  const mode = taskModeOf({ ...snap.settings.workflow, ...project.workflowOverrides });
  const set = (taskMode: WorkflowSettings["taskMode"] | undefined) => {
    const next = { ...project.workflowOverrides };
    if (taskMode === undefined) delete next.taskMode;
    else next.taskMode = taskMode;
    void saveProject({ ...project, workflowOverrides: next });
  };
  return (
    <div className="setrow" style={{ flexWrap: "wrap" }}>
      <div className="grow"><div className="lt row" style={{ gap: 8 }}>Task size<Support kind="engine" /></div><div className="ld">{TASK_MODES.find((m) => m.mode === mode)!.desc}</div></div>
      <ScopeChip overridden={overridden} onReset={() => set(undefined)} />
      <TaskModePicker value={mode} onChange={set} label="Task size for this project" />
    </div>
  );
}

/** This project's parallel tasks: inherited or its own. */
function ParallelRow({ project }: { project: Project }) {
  const { snap, saveProject } = useApp();
  const overridden = project.workflowOverrides.parallelTasks !== undefined;
  const value = overridden ? project.workflowOverrides.parallelTasks : snap.settings.workflow.parallelTasks ?? 1;
  const set = (parallelTasks: number | undefined) => {
    const next = { ...project.workflowOverrides };
    if (parallelTasks === undefined) delete next.parallelTasks;
    else next.parallelTasks = parallelTasks;
    void saveProject({ ...project, workflowOverrides: next });
  };
  return (
    <div className="setrow">
      <div className="grow"><div className="lt row" style={{ gap: 8 }}>Parallel tasks<Support kind="engine" /></div><div className="ld">Tasks at once, each in a worktree next to the project. Each approved change is checked again on the combined code before it is committed. On a local model server, at most as many tasks as it answers at once (llama.cpp slots, or the Ollama connection's requests at once). In Unattended mode the run limits count all tasks together.</div></div>
      <ScopeChip overridden={overridden} onReset={() => set(undefined)} />
      <select className="sel" value={String(value ?? 1)} onChange={(e) => set(Number(e.target.value))} aria-label="Parallel tasks for this project">
        <option value="1">One at a time</option><option value="2">2 at once</option><option value="3">3 at once</option><option value="4">4 at once</option>
      </select>
    </div>
  );
}

/** Kept parallel-task worktrees and branches (unfinished or unmerged tasks), cleared in one go. */
function ParallelCleanupRow({ project }: { project: Project }) {
  const { toast, statuses } = useApp();
  const [left, setLeft] = useState<{ worktrees: { path: string; branch: string | null }[]; branches: string[] } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const running = statuses[project.id]?.processAlive === true;
  const load = () => window.api.parallelLeftovers(project.id).then(setLeft, () => setLeft(null));
  useEffect(() => { void load(); }, [project.id, running]);
  if (!left || (left.worktrees.length === 0 && left.branches.length === 0)) return null;
  const shown = left.branches.slice(0, 5);
  const clean = async () => {
    setBusy(true);
    try {
      const r = await window.api.cleanParallel(project.id);
      setConfirming(false);
      if (r.problems.length) toast("error", `Removed ${plural(r.worktrees, "worktree")} and ${plural(r.branches, "branch", "branches")}; ${r.problems.join(" ")}`);
      else toast("success", `Removed ${plural(r.worktrees, "worktree")} and ${plural(r.branches, "branch", "branches")}`);
    } catch (error) { toast("error", cleanError(error)); }
    finally { setBusy(false); void load(); }
  };
  return (
    <div className="setrow">
      <div className="grow"><div className="lt row" style={{ gap: 8 }}>Kept parallel worktrees<Support kind="app" /></div><div className="ld">{plural(left.worktrees.length, "worktree")} and {plural(left.branches.length, "agent-dock/parallel-… branch", "agent-dock/parallel-… branches")} kept from tasks that did not finish or merge. The project's own node_modules is never touched.</div></div>
      <button className="btn sm" disabled={busy || running} title={running ? "Stop the automation first" : undefined} onClick={() => setConfirming(true)}>Clean up parallel worktrees</button>
      {confirming && (
        <Modal label="Clean up parallel worktrees" onClose={() => setConfirming(false)}>
          <h2 className="h2">Clean up parallel worktrees?</h2>
          <p className="sub" style={{ margin: 0 }}>Removes {plural(left.worktrees.length, "worktree")} in {project.path.split(/[\\/]/).filter(Boolean).pop()}-parallel and deletes these branches. Unmerged work on them will be lost.</p>
          {shown.length > 0 && <div className="mono sub" style={{ whiteSpace: "pre-wrap" }}>{shown.join("\n")}{left.branches.length > shown.length ? `\nand ${left.branches.length - shown.length} more` : ""}</div>}
          <div className="row"><span className="grow" /><button className="btn ghost" onClick={() => setConfirming(false)}>Cancel</button>
            <button className="btn danger-fill" disabled={busy || running} onClick={() => void clean()}>{busy ? "Cleaning up…" : "Clean up"}</button></div>
        </Modal>
      )}
    </div>
  );
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Scheduled runs: start this project automatically at a set time on chosen days (while Agent Dock is open). */
function ScheduleRow({ project }: { project: Project }) {
  const { saveProject } = useApp();
  const schedule: ProjectSchedule = project.schedule ?? { enabled: false, time: "02:00", days: [1, 2, 3, 4, 5] };
  const save = (next: Partial<ProjectSchedule>) => void saveProject({ ...project, schedule: { ...schedule, ...next } });
  return (
    <div className="setrow" style={{ flexWrap: "wrap" }}>
      <div className="grow"><div className="lt row" style={{ gap: 8 }}>Scheduled runs<Support kind="app" /></div><div className="ld">{describeSchedule(project.schedule)}. Starts the automation at this local time while Agent Dock is open{schedule.whenClosed ? `, or launches it when it is closed (${/Windows/.test(navigator.userAgent) ? "Windows Task Scheduler, also on battery" : "a systemd user timer"})` : ""}; a start missed by more than {SCHEDULE_GRACE_MINUTES} minutes is skipped{schedule.whenClosed ? " and reported" : ""}. Combine with Unattended mode for overnight runs.</div></div>
      {schedule.enabled && (
        <div className="row wrap" style={{ gap: 6 }}>
          <input className="input tnum" type="time" style={{ width: 110 }} value={schedule.time} aria-label="Scheduled start time" onChange={(e) => scheduleMinutes(e.target.value) !== null && save({ time: e.target.value })} />
          {DAY_NAMES.map((name, day) => (
            <button key={name} className={`btn sm${schedule.days.includes(day) ? " primary" : ""}`} aria-pressed={schedule.days.includes(day)} onClick={() => save({ days: schedule.days.includes(day) ? schedule.days.filter((d) => d !== day) : [...schedule.days, day].sort() })}>{name}</button>
          ))}
          {/Windows|Linux/.test(navigator.userAgent) && (
            <label className="row sub" style={{ gap: 6 }} title={/Windows/.test(navigator.userAgent) ? "Adds a task for you in Windows Task Scheduler that launches Agent Dock (minimized) at this time. No admin rights; it runs only while you are signed in." : "Adds a systemd user timer that launches the Agent Dock AppImage (minimized) at this time. No root; it runs while you are signed in, and a start missed while the PC was off runs at the next sign-in."}>
              <Toggle on={schedule.whenClosed === true} onChange={(v) => save({ whenClosed: v })} label="Also when Agent Dock is closed" />Also when closed
            </label>
          )}
          {/Windows/.test(navigator.userAgent) && schedule.whenClosed && (
            <label className="row sub" style={{ gap: 6 }} title="Lets Task Scheduler wake the PC from sleep for this start. It cannot start a PC that is shut down or hibernating, and Windows may block it on battery or when wake timers are off in the power plan.">
              <Toggle on={schedule.wakeToRun === true} onChange={(v) => save({ wakeToRun: v })} label="Wake the PC to run" />Wake to run
            </label>
          )}
        </div>
      )}
      <ScopeChip />
      <Toggle on={schedule.enabled} onChange={(v) => save({ enabled: v })} label="Scheduled runs" />
    </div>
  );
}

/** Pull-request mode: runs work on their own branch; you choose when to push it as a pull request. */
function PullRequestRow({ project }: { project: Project }) {
  const { saveProject, toast, statuses } = useApp();
  const [busy, setBusy] = useState(false);
  const running = statuses[project.id]?.processAlive === true;
  const open = async () => {
    setBusy(true);
    try { await window.api.openPullRequest(project.id); }
    catch (error) { toast("error", cleanError(error)); }
    finally { setBusy(false); }
  };
  return (
    <div className="setrow">
      <div className="grow"><div className="lt row" style={{ gap: 8 }}>Pull-request mode<Support kind="app" /></div><div className="ld">Each new run works on its own agent-dock/run-… branch instead of {project.prBase ?? "your current branch"}. Nothing is pushed until you press Open pull request, which pushes the branch and opens the pull request with GitHub CLI (or GitHub's compare page). On GitLab the push opens a merge request (or GitLab's new merge request page).</div></div>
      {project.prMode && <button className="btn sm" disabled={busy || running} title={running ? "Stop the automation first" : undefined} onClick={() => void open()}>{busy ? "Pushing…" : "Open pull request"}</button>}
      <ScopeChip />
      <Toggle on={project.prMode === true} onChange={(v) => void saveProject({ ...project, prMode: v })} label="Pull-request mode" />
    </div>
  );
}

const CI_LABEL: Record<CiState, string> = { pending: "Running", pass: "Passed", fail: "Failed", cancelled: "Cancelled", none: "No runs", unavailable: "Unavailable" };
const CI_ST: Record<CiState, StatusKind> = { pending: "active", pass: "done", fail: "blocked", cancelled: "attn", none: "pending", unavailable: "pending" };
const CHECK_ST: Record<CiCheck["bucket"], StatusKind> = { pending: "active", pass: "done", fail: "blocked", cancel: "attn", skipping: "pending" };

/** GitHub CI: the Actions runs of the pushed run branch, read with GitHub CLI, and the opt-in fix loop. */
function CiRow({ project }: { project: Project }) {
  const { saveProject, toast, statuses } = useApp();
  const [ci, setCi] = useState<CiStatus | null>(null);
  const [busy, setBusy] = useState<"" | "refresh" | "fix">("");
  const running = statuses[project.id]?.processAlive === true;
  useEffect(() => {
    let live = true;
    void window.api.ciStatus(project.id).then((s) => { if (live) setCi(s); }).catch(() => {});
    const off = window.api.onCi((s) => { if (s.projectId === project.id) setCi(s); });
    return () => { live = false; off(); };
  }, [project.id]);
  const act = async (kind: "refresh" | "fix") => {
    setBusy(kind);
    try { setCi(await (kind === "refresh" ? window.api.refreshCi(project.id) : window.api.fixCi(project.id))); }
    catch (error) { toast("error", cleanError(error)); }
    finally { setBusy(""); }
  };
  const watch = ci?.watch ?? null;
  if (!project.prMode && !watch) return null;
  return (
    <div className="setrow" style={{ alignItems: "flex-start" }}>
      <div className="grow">
        <div className="lt row" style={{ gap: 8 }}>GitHub CI<Support kind="app" />
          {watch && ci && <span className="row sub" style={{ gap: 6 }}><St kind={CI_ST[ci.state]} title={CI_LABEL[ci.state]} />{watch.fixing ? "Fixing" : CI_LABEL[ci.state]}</span>}
        </div>
        <div className="ld">
          {watch
            ? <>GitHub Actions runs of {watch.branch} at <span className="mono">{watch.sha.slice(0, 7)}</span>, pushed {ago(watch.pushedAt)}{ci?.checkedAt ? `, checked ${ago(ci.checkedAt)}` : ""}. Read with GitHub CLI as you (gh auth login); the app stores no GitHub token.{watch.prUrl && <> <a href={watch.prUrl} target="_blank" rel="noreferrer">Pull request</a></>}</>
            : "After Open pull request, the app shows that commit's GitHub Actions runs here and tells you when they finish. It reads them with GitHub CLI as you (gh auth login) and stores no GitHub token."}
          {ci?.message && <div className="sub">{ci.message}</div>}
        </div>
        {ci && ci.checks.length > 0 && (
          <div className="col" style={{ gap: 4, marginTop: 8 }}>
            {ci.checks.map((c) => (
              <div key={`${c.id}-${c.name}`} className="row sub" style={{ gap: 6 }}>
                <St kind={CHECK_ST[c.bucket]} title={c.bucket} />
                {c.url ? <a href={c.url} target="_blank" rel="noreferrer">{c.workflow || c.name}</a> : <span>{c.workflow || c.name}</span>}
                {c.workflow && c.name !== c.workflow && <span className="mut">{c.name}</span>}
                {c.event && <span className="mut">· {c.event.replaceAll("_", " ")}</span>}
              </div>
            ))}
          </div>
        )}
        <label className="row sub" style={{ gap: 6, marginTop: 8 }} title={`When CI fails, start a run that fixes it from the failed log, then push the branch again. At most ${CI_FIX_MAX} fix runs per push of yours; checks and tests are never weakened to pass.`}>
          <Toggle on={project.ciFixLoop === true} onChange={(v) => void saveProject({ ...project, ciFixLoop: v })} label="Fix CI failures automatically" />
          Fix failures automatically (pushes the fix){watch && watch.fixAttempts > 0 ? ` · ${watch.fixAttempts} of ${CI_FIX_MAX} fix runs used` : ""}
        </label>
      </div>
      {watch && <button className="btn sm" disabled={busy !== ""} onClick={() => void act("refresh")}>{busy === "refresh" ? "Checking…" : "Refresh"}</button>}
      {watch && ci?.state === "fail" && !watch.fixing && <button className="btn sm" disabled={busy !== "" || running} title={running ? "Stop the automation first" : "Starts a run that fixes it from the failed log"} onClick={() => void act("fix")}>{busy === "fix" ? "Starting…" : "Fix CI failure"}</button>}
      <ScopeChip />
    </div>
  );
}

/** Parallel lanes: extra tasks side by side, each in its own git worktree, branch and engine. */
function LanesRow({ project }: { project: Project }) {
  const { snap, setProjects, toast, statuses } = useApp();
  const [name, setName] = useState("");
  const [objective, setObjective] = useState("");
  const [busy, setBusy] = useState(false);
  const lanes = snap.projects.filter((p) => p.parentId === project.id);
  const act = async (fn: () => Promise<Project[]>, done: string) => {
    setBusy(true);
    try { setProjects(await fn()); toast("success", done); setName(""); setObjective(""); }
    catch (error) { toast("error", cleanError(error)); }
    finally { setBusy(false); }
  };
  const merge = async (laneId: string) => {
    setBusy(true);
    try { await window.api.mergeLane(laneId); }
    catch (error) { toast("error", cleanError(error)); }
    finally { setBusy(false); }
  };
  return (
    <div className="setrow" style={{ flexWrap: "wrap", alignItems: "flex-start" }}>
      <div className="grow" style={{ minWidth: 260 }}>
        <div className="lt row" style={{ gap: 8 }}>Parallel lanes<Support kind="app" /></div>
        <div className="ld">Run another objective at the same time in a git worktree of this project, on its own agent-dock/lane-… branch with its own engine. Each lane appears as its own project; Merge brings its branch into this project's branch as one merge commit (a conflict merges nothing), or open a pull request from it. Lanes use your CLIs' limits in parallel.</div>
        {lanes.length > 0 && (
          <div className="stack" style={{ gap: 6, marginTop: 8 }}>
            {lanes.map((l) => (
              <div className="row" key={l.id} style={{ gap: 8 }}>
                <span className="mono sub grow ellipsis" title={l.path}>{l.laneBranch ?? l.name}</span>
                <button className="btn sm" disabled={busy || statuses[l.id]?.processAlive || statuses[project.id]?.processAlive} title={`Merge ${l.laneBranch ?? "the lane"} into the branch this project has checked out`} onClick={() => void merge(l.id)}>Merge</button>
                <button className="btn sm" disabled={busy || statuses[l.id]?.processAlive} onClick={() => void act(() => window.api.removeLane(l.id, false), "Lane removed; its branch is kept")}>Remove</button>
              </div>
            ))}
          </div>
        )}
        <div className="row wrap" style={{ gap: 6, marginTop: 8 }}>
          <input className="input" style={{ width: 160 }} placeholder="Lane name" aria-label="Lane name" value={name} onChange={(e) => setName(e.target.value)} />
          <input className="input grow" style={{ minWidth: 200 }} placeholder="Objective (defaults to this project's)" aria-label="Lane objective" value={objective} onChange={(e) => setObjective(e.target.value)} />
          <button className="btn sm" disabled={busy || !name.trim()} onClick={() => void act(() => window.api.addLane(project.id, name, objective), "Lane added as its own project")}>Add lane</button>
        </div>
      </div>
    </div>
  );
}

/** Opt-in WSL isolation: the engine and its agent CLIs run inside a WSL distro. */
function WslRow({ project }: { project: Project }) {
  const { saveProject, toast, statuses } = useApp();
  const wsl = project.wsl ?? { enabled: false, distro: "" };
  const [distro, setDistro] = useState(wsl.distro);
  const [check, setCheck] = useState<{ ok: boolean; lines: string[] } | null>(null);
  const running = statuses[project.id]?.processAlive === true;
  const save = (next: Partial<typeof wsl>) => void saveProject({ ...project, wsl: { ...wsl, ...next } });
  const runCheck = async () => {
    try { const result = await window.api.checkWsl(distro.trim()); setCheck(result); if (result.ok) save({ distro: distro.trim() }); }
    catch (error) { toast("error", cleanError(error)); }
  };
  return (
    <div className="setrow" style={{ flexWrap: "wrap", alignItems: "flex-start" }}>
      <div className="grow" style={{ minWidth: 260 }}>
        <div className="lt row" style={{ gap: 8 }}>WSL isolation (opt-in)<Support kind="engine" /></div>
        <div className="ld">Runs the engine, and every agent CLI and command it starts, inside a WSL distro instead of Windows. Node.js, git and your agent CLIs must be installed and signed in inside the distro. Windows drives stay reachable under /mnt unless automount is off in the distro's /etc/wsl.conf; for the strongest separation keep the project in the distro (\\wsl$\…). Takes effect at the next start.</div>
        <div className="row wrap" style={{ gap: 6, marginTop: 8 }}>
          <input className="input" style={{ width: 180 }} placeholder="Distro, e.g. Ubuntu" aria-label="WSL distro" value={distro} onChange={(e) => setDistro(e.target.value)} />
          <button className="btn sm" disabled={!distro.trim()} onClick={() => void runCheck()}>Check distro</button>
        </div>
        {check && <div className={`mono sub ${check.ok ? "ok" : "err"}`} style={{ marginTop: 6, whiteSpace: "pre-wrap" }}>{check.lines.join("\n") || "No answer from WSL."}</div>}
      </div>
      <ScopeChip />
      <Toggle on={wsl.enabled} onChange={(v) => { if (v && !(wsl.distro || distro.trim())) return toast("warning", "Enter and check a distro first."); save({ enabled: v, distro: wsl.distro || distro.trim() }); }} label="WSL isolation" danger={running} />
    </div>
  );
}

function AgentsTab({ project }: { project: Project }) {
  const { snap, saveProject } = useApp();
  return (
    <div className="fade-in well scroll-x" style={{ padding: 6 }}>
      <table className="tbl" style={{ minWidth: 600 }}>
        <thead><tr><th>Workflow role</th><th>Agent for this project</th><th>Source</th></tr></thead>
        <tbody>
          {ROLES.map(([role, label]) => {
            const override = project.roleOverrides[role];
            const global = agentForRoleClient(role, { ...project, roleOverrides: {} }, snap.agents);
            const candidates = snap.agents.filter((a) => a.role === role);
            return (
              <tr key={role}>
                <td style={{ fontWeight: 600 }}>{label}</td>
                <td>
                  <label className="sr" htmlFor={`role-${role}`}>{label} agent</label>
                  <select id={`role-${role}`} className="sel" style={{ minWidth: 280 }} value={override ?? "inherit"} onChange={(e) => {
                    const next = { ...project.roleOverrides };
                    if (e.target.value === "inherit") delete next[role];
                    else next[role] = e.target.value;
                    void saveProject({ ...project, roleOverrides: next });
                  }}>
                    <option value="inherit">Inherit global default ({global?.name ?? "none"})</option>
                    {candidates.map((a) => <option key={a.id} value={a.id}>{a.name}{a.enabled ? "" : " (disabled)"}</option>)}
                  </select>
                </td>
                <td><span className={`chip ${override ? "lav" : "mut"}`}>{override ? "Project override" : "Global default"}</span></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function HistoryTab({ project }: { project: Project }) {
  const { toast, statuses } = useApp();
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);
  const running = statuses[project.id]?.processAlive === true;
  const rerun = async (taskId: string) => {
    try { await window.api.rerunTask(project.id, taskId); toast("success", `Running ${taskId} again`); }
    catch (error) { toast("error", cleanError(error)); }
  };
  useEffect(() => {
    void window.api.history(project.id).then(setHistory);
  }, [project.id]);
  const tone = { approved: "ok", failed: "err", attention: "attn", blocked: "err", stopped: "warn" } as const;
  if (!history) return <div className="skel" style={{ width: "60%" }} />;
  if (!history.length) return <Empty title="No tasks have run in this project yet" icon="play" />;
  return (
    <div className="fade-in well" style={{ padding: 6 }}>
      {/* Fixed columns so the table fits its card; a long task id or summary is cut with its full text on hover. */}
      <table className="tbl usage-tbl">
        <colgroup><col style={{ width: "18%" }} /><col style={{ width: 104 }} /><col style={{ width: 84 }} /><col /><col style={{ width: 104 }} /><col style={{ width: 116 }} /></colgroup>
        <thead><tr><th>Task</th><th>Outcome</th><th className="num">Attempts</th><th>Summary</th><th>When</th><th /></tr></thead>
        <tbody>
          {history.map((h) => (
            <tr key={h.taskId}>
              <td><div className="mono ellipsis" title={h.taskId}>{h.taskId}</div></td>
              <td><span className={`chip ${tone[h.outcome]}`}>{h.outcome}</span></td>
              <td className="num">{h.attempts || "—"}</td>
              <td className="sub"><div className="ellipsis" title={h.summary || undefined}>{h.summary || "—"}</div></td>
              <td className="sub"><div className="ellipsis" title={h.finishedAt ? new Date(h.finishedAt).toLocaleString() : undefined}>{ago(h.finishedAt)}</div></td>
              <td>{h.canRerun && <button className="btn sm" disabled={running} title={running ? "Stop the automation first" : "Run this task again with the same prompt, files and check"} onClick={() => void rerun(h.taskId)}>Run again</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ProjectsPage() {
  const { snap, statuses, activeProject, setActive, saveProject, setProjects, toast } = useApp();
  const [filter, setFilter] = useState<"active" | "archived">("active");
  const [query, setQuery] = useState("");
  const [selId, setSelId] = useState<string | null>(activeProject?.id ?? snap.projects[0]?.id ?? null);
  const [tab, setTab] = useState<DetailTab>("overview");
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [wipe, setWipe] = useState(false);
  const [editing, setEditing] = useState<{ objective: string; description: string } | null>(null);

  useEffect(() => {
    const open = () => setAdding(true);
    window.addEventListener("app:add-project", open);
    return () => window.removeEventListener("app:add-project", open);
  }, []);

  const scope = snap.projects.filter((p) => (filter === "archived") === p.archived);
  const list = scope.filter((p) => !query || `${p.name} ${p.path} ${p.repoUrl ?? ""}`.toLowerCase().includes(query.toLowerCase()));
  const sel = snap.projects.find((p) => p.id === selId && scope.includes(p)) ?? list[0] ?? null;
  const s = sel ? statuses[sel.id] : undefined;

  useEffect(() => {
    if (sel && !statuses[sel.id]) void window.api.status(sel.id).catch(() => {});
  }, [sel, statuses]);

  return (
    <>
      <div className="row wrap" style={{ gap: 14 }}>
        <div>
          <h1 className="h1">Projects</h1>
          <div className="sub">{snap.projects.filter((p) => !p.archived).length} registered workspaces · settings and history are kept per project</div>
        </div>
        <span className="grow" />
        <Tabs label="Project filter" small value={filter} onChange={setFilter} options={[
          { value: "active", label: `Active · ${snap.projects.filter((p) => !p.archived).length}` },
          { value: "archived", label: `Archived · ${snap.projects.filter((p) => p.archived).length}` },
        ]} />
        <button className="btn primary" onClick={() => setAdding(true)} title="Add project (Ctrl+N)"><Icon name="plus" size="sm" />Add project</button>
      </div>

      {snap.projects.length === 0 ? (
        <Empty title="No projects yet" icon="folder">
          <span>Register an existing repository, clone one from GitHub, or create a new workspace.</span>
          <button className="btn primary" onClick={() => setAdding(true)}>Add project</button>
        </Empty>
      ) : (
        <div className="split">
          <div className="stack" style={{ gap: 14 }}>
            <label className="sr" htmlFor="psearch">Filter projects</label>
            <input id="psearch" className="input" placeholder="Filter by name, path or repository" value={query} onChange={(e) => setQuery(e.target.value)} />
            {list.map((p) => {
              const st = statuses[p.id];
              const plan = st?.plan;
              return (
                <button key={p.id} className={`item ${sel?.id === p.id ? "on" : ""}`} onClick={() => setSelId(p.id)} aria-pressed={sel?.id === p.id}>
                  <div className="row">
                    <span className="name ellipsis" style={{ fontWeight: 600, fontSize: 14 }}>{p.name}</span>
                    {p.id === activeProject?.id && <span className="chip info" style={{ height: 18, fontSize: 10.5 }}>Active</span>}
                    <span className="grow" />
                    {st && <span className={`row ${runTone[st.runState].text}`} style={{ gap: 6, fontSize: 12 }}><Dot tone="" />{st.label}</span>}
                  </div>
                  <div className="mono mut ellipsis" style={{ fontSize: 11.5 }}>{p.path}</div>
                  <div className="row sub" style={{ fontSize: 11.5 }}>
                    <Icon name="branch" size="sm" />
                    <span className="ellipsis">{p.repoUrl ? p.repoUrl.replace(/^https:\/\/github.com\//, "") : "local only"}</span>
                    {st?.git.branch && <><span>·</span><span className="mono">{st.git.branch}</span></>}
                  </div>
                  <div className="row" style={{ gap: 10 }}>
                    <div className="grow"><Bar pct={plan?.percent ?? 0} /></div>
                    <span className="sub tnum" style={{ fontSize: 11 }}>{plan?.total ? `${plan.percent}% · ${plan.completed}/${plan.total}` : "No plan"}</span>
                  </div>
                  <div className="sub" style={{ fontSize: 11 }}>Last activity {ago(st?.updatedAt)}</div>
                </button>
              );
            })}
            {list.length === 0 && <div className="well empty">{query ? `No projects match “${query}”.` : filter === "archived" ? "No archived projects." : "No active projects."}</div>}
          </div>

          {sel && (
            <section className="card pad stack fade-in" aria-label="Project details" style={{ gap: 18 }} key={sel.id}>
              <div className="row wrap" style={{ gap: 12, alignItems: "flex-start" }}>
                <div className="grow">
                  <div className="row"><h2 className="h1">{sel.name}</h2>{s && <span className={`chip ${runTone[s.runState].text}`}><Dot tone="" />{s.label}</span>}</div>
                  <p className="sub" style={{ margin: "6px 0 0", maxWidth: 640 }}>{sel.description || "No description."}</p>
                </div>
                <div className="row wrap" style={{ gap: 10 }}>
                  {!sel.archived && sel.id !== activeProject?.id && <button className="btn primary sm" onClick={() => { void setActive(sel.id); toast("success", `${sel.name} is now the active project`); }}>Set as active project</button>}
                  {sel.archived && <button className="btn sm" onClick={async () => { await saveProject({ ...sel, archived: false }); setFilter("active"); toast("success", `${sel.name} restored`); }}>Restore</button>}
                  <button className="btn sm" onClick={() => window.api.openPath(sel.path)}><Icon name="external" size="sm" />Open folder</button>
                  <button className="btn sm" onClick={() => setEditing({ objective: sel.objective, description: sel.description })}>Edit</button>
                  {!sel.archived && <button className="btn sm" disabled={s?.processAlive} title={s?.processAlive ? "Stop the automation first" : undefined} onClick={async () => {
                    await saveProject({ ...sel, archived: true });
                    if (activeProject?.id === sel.id) await setActive(snap.projects.find((p) => !p.archived && p.id !== sel.id)?.id ?? null);
                    toast("success", `${sel.name} archived · files untouched`);
                  }}>Archive</button>}
                  <button className="btn sm danger" disabled={s?.processAlive} onClick={() => { setWipe(false); setRemoving(true); }}>Remove…</button>
                </div>
              </div>

              <Tabs<DetailTab> label="Project sections" small value={tab} onChange={setTab} options={[
                { value: "overview", label: "Overview" },
                { value: "plan", label: "Implementation plan" },
                { value: "agents", label: "Agents" },
                { value: "workflow", label: "Workflow" },
                { value: "history", label: "Task history" },
              ]} />

              {tab === "overview" && (
                <div className="fade-in stack" style={{ gap: 18 }}>
                  <div className="well pad stack" style={{ gap: 6 }}>
                    <div className="eyebrow">Objective</div>
                    <div className="selectable">{sel.objective || <span className="sub">Not set. Use the prompt bar (Ctrl+K) or Edit.</span>}</div>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 18 }}>
                    <div className="well pad stack" style={{ gap: 14 }}>
                      <div className="row titlerow"><h3 className="h3">Repository</h3><span className="grow" /><span className={`chip ${s?.git.isRepo ? "ok" : "err"}`}>{s?.git.isRepo ? (s.git.remote ? "Linked" : "Local repository") : "Not a Git repository"}</span></div>
                      <dl className="kv two">
                        <div style={{ gridColumn: "1 / -1" }}><dt>Remote</dt><dd className={s?.git.remote ? "mono" : undefined}>{s?.git.remote ?? "—"}</dd></div>
                        <div><dt>Active branch</dt><dd className="mono">{s?.git.branch ?? "—"}</dd></div>
                        <div><dt>HEAD</dt><dd className="mono">{s?.git.head?.slice(0, 10) ?? "—"}</dd></div>
                        <div><dt>Sync</dt><dd>{s?.git.ahead != null ? `${s.git.ahead} ahead · ${s.git.behind} behind` : "No upstream"}</dd></div>
                        <div><dt>Working tree</dt><dd>{s ? (s.git.changedFiles.length ? `${s.git.changedFiles.length} changed` : "Clean") : "—"}</dd></div>
                      </dl>
                    </div>
                    <div className="well pad stack" style={{ gap: 14 }}>
                      <div className="row titlerow"><h3 className="h3">Workspace</h3></div>
                      <dl className="kv two">
                        <div style={{ gridColumn: "1 / -1" }}><dt>Location</dt><dd className="mono wrapok">{sel.path}</dd></div>
                        <div><dt>Implementation plan</dt><dd className="mono">{s?.plan.error ? "not found" : s?.plan.source ?? "—"}</dd></div>
                        <div><dt>Registered</dt><dd>{longDate(sel.createdAt)}</dd></div>
                        <div><dt>Progress</dt><dd>{s?.plan.total ? `${s.plan.percent}% · ${s.plan.completed} of ${s.plan.total}` : "—"}</dd></div>
                        <div><dt>Last activity</dt><dd>{ago(s?.updatedAt)}</dd></div>
                      </dl>
                    </div>
                  </div>
                </div>
              )}
              {tab === "plan" && (
                <div className="fade-in stack" style={{ gap: 14 }}>
                  <div className="row wrap"><span className="sub">Source</span><span className="mono">{s?.plan.source}</span><span className="grow" /><button className="btn sm" onClick={() => window.api.openPath(`${sel.path}\\IMPLEMENTATION_PLAN.md`)} disabled={Boolean(s?.plan.error)}>Open plan file</button></div>
                  <div className="well pad stack" style={{ gap: 14 }}>
                    {s?.plan.phases.map((p) => (
                      <div className="row" key={p.number} style={{ gap: 14 }}>
                        <St kind={p.total && p.completed === p.total ? "done" : p.completed ? "part" : "pending"} />
                        <span style={{ width: 260 }} className="ellipsis">Phase {p.number} · {p.title}</span>
                        <div className="grow"><Bar pct={p.percent ?? 0} /></div>
                        <span className="sub tnum" style={{ width: 52, textAlign: "right" }}>{p.completed}/{p.total}</span>
                      </div>
                    ))}
                    {!s?.plan.phases.length && <div className="empty">{s?.plan.error ?? "The plan has no phases."}</div>}
                  </div>
                </div>
              )}
              {tab === "agents" && <AgentsTab project={sel} />}
              {tab === "workflow" && <WorkflowTab project={sel} />}
              {tab === "history" && <HistoryTab project={sel} />}
            </section>
          )}
        </div>
      )}

      {adding && (
        <AddProjectDialog
          onClose={() => setAdding(false)}
          onAdded={async (p) => {
            setAdding(false);
            setProjects([...snap.projects, p]);
            setSelId(p.id);
            setFilter("active");
            if (!activeProject) await setActive(p.id);
            toast("success", `${p.name} registered`);
          }}
        />
      )}
      {removing && sel && (
        <Modal label="Remove project" onClose={() => setRemoving(false)}>
          <h2 className="h2">Remove {sel.name} from the app?</h2>
          <ul className="sub" style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 6 }}>
            <li>Source files in <span className="mono">{sel.path}</span> are not touched.</li>
            <li>The remote repository is not affected.</li>
          </ul>
          <label className="row" style={{ gap: 10 }}><Toggle on={wipe} onChange={setWipe} label="Also delete engine history" /><span>Also delete this project's engine state and task history</span></label>
          <div className="row"><span className="grow" /><button className="btn ghost" onClick={() => setRemoving(false)}>Cancel</button>
            <button className="btn danger-fill" onClick={async () => {
              try {
                setProjects(await window.api.removeProject(sel.id, wipe));
                setRemoving(false);
                toast("success", `${sel.name} removed from the app · source files untouched`);
              } catch (e) {
                toast("error", cleanError(e));
              }
            }}>Remove from app</button>
          </div>
        </Modal>
      )}
      {editing && sel && (
        <Modal label="Edit project" title={`Edit ${sel.name}`} onClose={() => setEditing(null)}>
          <label className="field"><span>Objective</span><textarea className="ta" value={editing.objective} onChange={(e) => setEditing({ ...editing, objective: e.target.value })} /></label>
          <label className="field"><span>Description</span><textarea className="ta" style={{ minHeight: 60 }} value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} /></label>
          {s?.processAlive && <div className="sub">The running engine keeps its current objective until it is restarted.</div>}
          <div className="row"><span className="grow" /><button className="btn ghost" onClick={() => setEditing(null)}>Cancel</button>
            <button className="btn primary" onClick={async () => { await saveProject({ ...sel, ...editing }); setEditing(null); toast("success", "Project saved"); }}>Save</button>
          </div>
        </Modal>
      )}
    </>
  );
}
