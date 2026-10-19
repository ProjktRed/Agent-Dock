import { useEffect, useState } from "react";
import { describeSchedule, SCHEDULE_GRACE_MINUTES, scheduleMinutes } from "@shared/schedule";
import type { HistoryEntry } from "@shared/api";
import type { Project, ProjectSchedule, WorkflowSettings } from "@shared/types";
import { cleanError, useApp } from "../../store";
import { ago, runTone } from "../../lib/format";
import { agentForRoleClient } from "../../lib/agents";
import { Icon } from "../../components/Icon";
import { Bar, Dot, Empty, Modal, St, Support, Tabs, Toggle } from "../../components/ui";
import { AddProjectDialog } from "./AddProjectDialog";

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
    <div className="fade-in well pad">
      {rows.map((r) => {
        const overridden = r.key in project.workflowOverrides;
        const value = (overridden ? project.workflowOverrides[r.key] : global[r.key]) as boolean;
        return (
          <div className="setrow" key={r.key}>
            <div className="grow"><div className="lt row" style={{ gap: 8 }}>{r.label}<Support kind={r.support} /></div><div className="ld">{r.desc}</div></div>
            <span className={`chip ${overridden ? "lav" : "mut"}`}>{overridden ? "Project override" : "Inherited"}</span>
            {overridden && <button className="btn ghost sm" onClick={() => set(r.key, undefined)}>Reset</button>}
            <Toggle on={value} onChange={(v) => set(r.key, v)} label={r.label} />
          </div>
        );
      })}
      <ScheduleRow project={project} />
      <PullRequestRow project={project} />
      <div className="setrow">
        <div className="grow"><div className="lt row" style={{ gap: 8 }}>Engine state folder<Support kind="engine" /></div><div className="ld mono">{project.stateDir}</div></div>
        <button className="btn sm" onClick={() => window.api.openPath(project.stateDir)}>Open</button>
      </div>
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
      <div className="grow"><div className="lt row" style={{ gap: 8 }}>Scheduled runs<Support kind="app" /></div><div className="ld">{describeSchedule(project.schedule)}. Starts the automation at this local time while Agent Dock is open; a start missed by more than {SCHEDULE_GRACE_MINUTES} minutes is skipped. Combine with Unattended mode for overnight runs.</div></div>
      {schedule.enabled && (
        <div className="row wrap" style={{ gap: 6 }}>
          <input className="input mono" type="time" style={{ width: 110 }} value={schedule.time} aria-label="Scheduled start time" onChange={(e) => scheduleMinutes(e.target.value) !== null && save({ time: e.target.value })} />
          {DAY_NAMES.map((name, day) => (
            <button key={name} className={`btn sm${schedule.days.includes(day) ? " primary" : ""}`} aria-pressed={schedule.days.includes(day)} onClick={() => save({ days: schedule.days.includes(day) ? schedule.days.filter((d) => d !== day) : [...schedule.days, day].sort() })}>{name}</button>
          ))}
        </div>
      )}
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
      <div className="grow"><div className="lt row" style={{ gap: 8 }}>Pull-request mode<Support kind="app" /></div><div className="ld">Each new run works on its own agent-dock/run-… branch instead of {project.prBase ?? "your current branch"}. Nothing is pushed until you press Open pull request, which pushes the branch and opens the pull request with GitHub CLI (or GitHub's compare page).</div></div>
      {project.prMode && <button className="btn sm" disabled={busy || running} title={running ? "Stop the automation first" : undefined} onClick={() => void open()}>{busy ? "Pushing…" : "Open pull request"}</button>}
      <Toggle on={project.prMode === true} onChange={(v) => void saveProject({ ...project, prMode: v })} label="Pull-request mode" />
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
    <div className="fade-in well scroll-x" style={{ padding: 6 }}>
      <table className="tbl" style={{ minWidth: 640 }}>
        <thead><tr><th>Task</th><th>Outcome</th><th>Attempts</th><th>Summary</th><th>When</th><th /></tr></thead>
        <tbody>
          {history.map((h) => (
            <tr key={h.taskId}>
              <td className="mono nowrap">{h.taskId}</td>
              <td><span className={`chip ${tone[h.outcome]}`}>{h.outcome}</span></td>
              <td className="mono">{h.attempts || "—"}</td>
              <td className="sub" style={{ maxWidth: 360 }}><span className="ellipsis" style={{ display: "block" }} title={h.summary}>{h.summary || "—"}</span></td>
              <td className="sub nowrap">{ago(h.finishedAt)}</td>
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
                    <span className="sub mono" style={{ fontSize: 11 }}>{plan?.total ? `${plan.percent}% · ${plan.completed}/${plan.total}` : "No plan"}</span>
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
                      <div className="row"><h3 className="h3">Repository</h3><span className="grow" /><span className={`chip ${s?.git.isRepo ? "ok" : "err"}`}>{s?.git.isRepo ? (s.git.remote ? "Linked" : "Local repository") : "Not a Git repository"}</span></div>
                      <dl className="kv two">
                        <div style={{ gridColumn: "1 / -1" }}><dt>Remote</dt><dd className="mono">{s?.git.remote ?? "—"}</dd></div>
                        <div><dt>Active branch</dt><dd className="mono">{s?.git.branch ?? "—"}</dd></div>
                        <div><dt>HEAD</dt><dd className="mono">{s?.git.head?.slice(0, 10) ?? "—"}</dd></div>
                        <div><dt>Sync</dt><dd>{s?.git.ahead != null ? `${s.git.ahead} ahead · ${s.git.behind} behind` : "No upstream"}</dd></div>
                        <div><dt>Working tree</dt><dd>{s ? (s.git.changedFiles.length ? `${s.git.changedFiles.length} changed` : "Clean") : "—"}</dd></div>
                      </dl>
                    </div>
                    <div className="well pad stack" style={{ gap: 14 }}>
                      <h3 className="h3">Workspace</h3>
                      <dl className="kv two">
                        <div style={{ gridColumn: "1 / -1" }}><dt>Location</dt><dd className="mono wrapok">{sel.path}</dd></div>
                        <div><dt>Implementation plan</dt><dd className="mono">{s?.plan.error ? "not found" : s?.plan.source ?? "—"}</dd></div>
                        <div><dt>Registered</dt><dd>{new Date(sel.createdAt).toLocaleDateString()}</dd></div>
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
                        <span className="sub mono" style={{ width: 52, textAlign: "right" }}>{p.completed}/{p.total}</span>
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
