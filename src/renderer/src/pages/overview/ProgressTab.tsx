import { Fragment, useEffect, useState } from "react";
import type { EngineEvent, PlanPhase, PlanProposal, ProjectStatus, RunReport } from "@shared/types";
import { useApp } from "../../store";
import { clock, duration, engineStageLabel, num, plural, sentenceCase, tokens } from "../../lib/format";
import { modeEstimates, planEstimate } from "../../lib/estimate";
import { TASK_MODES, taskModeOf } from "@shared/task-mode";
import { describeEvent, isHiddenEvent } from "../../lib/events";
import { agentForRoleClient } from "../../lib/agents";
import { Icon } from "../../components/Icon";
import { Bar, Disclosure, Dot, Empty, St, type StatusKind } from "../../components/ui";

const CYCLE = [
  { key: "assessment", name: "Assessment", agent: "Plans one bounded task" },
  { key: "implementation", name: "Implementation", agent: "Makes the change" },
  { key: "qa", name: "QA", agent: "Verifies, commits on pass" },
  { key: "correction", name: "Correction / Elevation", agent: "Only after a failed QA" },
  { key: "next", name: "Next task", agent: "Back to Assessment" },
] as const;

function AttentionPanel({ s, projectId }: { s: ProjectStatus; projectId: string }) {
  const { control, activeProject, toast } = useApp();
  const kind = s.runState;
  // Codex's Windows sandbox failed to prepare a folder QA writes to (usually the shared .git).
  const sandboxError = kind === "blocked" && /helper_unknown_error|setup refresh had errors/i.test(s.blockedReason ?? "");
  const [owner, setOwner] = useState<{ dir: string; owner: string; user: string; command: string } | null | undefined>(undefined);
  useEffect(() => {
    if (!sandboxError) return;
    let live = true;
    const check = () => window.api.gitOwner(projectId).then((o) => live && setOwner(o)).catch(() => live && setOwner(null));
    void check();
    const t = setInterval(check, 15_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [sandboxError, projectId]);
  if (!["attention", "blocked", "waiting-limit"].includes(kind)) return null;
  const meta = {
    attention: { title: "Attention required: manual review", tone: "attnb", text: s.attentionReason, help: "The engine stopped for your review. Elevation can propose a revised correction, which then goes through independent QA." },
    blocked: s.assessmentRetry
      ? { title: "Blocked: Assessment could not choose a task", tone: "errb", text: s.blockedReason, help: "Assessment stopped before any task started, so nothing was changed. Fix the cause it reports if there is one, then retry: the engine runs Assessment again." }
      : { title: "Blocked: safe continuation is not possible", tone: "errb", text: s.blockedReason, help: "Scope, HEAD, permission or state problems never continue automatically. The diff is left in place for inspection." },
    "waiting-limit": { title: "Waiting: orchestrator usage limit", tone: "warnb", text: s.limitMessage, help: "Resume reruns only the interrupted Assessment or QA operation with the same inputs." },
  }[kind as "attention" | "blocked" | "waiting-limit"];
  return (
    <section id="attention-panel" className={`banner ${meta.tone} fade-in`} role="alert" style={{ padding: 18 }}>
      <Icon name="warn" className={kind === "blocked" ? "err" : "attn"} />
      <div className="grow stack" style={{ gap: 10 }}>
        <div style={{ fontWeight: 600, color: "var(--t)" }}>{meta.title}</div>
        {meta.text && <div className="mono log" style={{ maxHeight: 140 }}>{meta.text}</div>}
        {s.limitRetryAt && <div className="sub">Provider reports retry after: {s.limitRetryAt}</div>}
        <div className="sub">{meta.help}</div>
        {sandboxError && (
          <div className="well pad stack" style={{ gap: 8 }}>
            <b style={{ fontWeight: 600 }}>Codex could not start any command for QA</b>
            {owner === undefined ? (
              <span className="sub">Checking the repository's .git folder…</span>
            ) : owner ? (
              <>
                <span className="sub">Its Windows sandbox has to change the permissions of <span className="mono">{owner.dir}</span> so QA can commit, but that folder belongs to <b>{owner.owner}</b>, not to you ({owner.user}). This happens when a sandboxed Codex created the repository.</span>
                <span className="sub">Open Windows PowerShell as Administrator and run this once. It makes you the owner and leaves the permissions as they are:</span>
                <div className="mono log selectable" style={{ maxHeight: 60 }}>{owner.command}</div>
                <span className="sub">Then press Retry QA. This page rechecks the folder every 15 seconds.</span>
              </>
            ) : (
              <span className="sub">The repository's .git folder now belongs to you{s.qaRetry ? ", so QA can run again: press Retry QA." : "."} If it fails again, Codex's sandbox log is in <span className="mono">%USERPROFILE%\.codex\.sandbox</span>.</span>
            )}
          </div>
        )}
        <div className="row wrap" style={{ gap: 10 }}>
          {s.elevateAvailable && <button className="btn primary sm" onClick={() => control(projectId, "elevate", "Elevation requested")}>Elevate</button>}
          {s.resolverAvailable && <button className="btn primary sm" onClick={() => control(projectId, "resolve", "Resolver requested")}>Resolve block</button>}
          {(kind === "waiting-limit" || kind === "attention") && <button className="btn sm" onClick={() => control(projectId, "resume", "Resumed")}>Resume</button>}
          {kind === "blocked" && s.assessmentRetry && <button className="btn primary sm" onClick={() => control(projectId, "resume", "Assessment restarted")}>Retry Assessment</button>}
          {kind === "blocked" && s.qaRetry && <button className="btn primary sm" disabled={sandboxError && Boolean(owner)} title={sandboxError && owner ? "Fix the folder owner first" : "Collect fresh check results for the finished attempt and let QA review it again"} onClick={() => control(projectId, "retry-qa", "QA restarted on the finished attempt")}>Retry QA</button>}
          {(kind === "blocked" || kind === "attention") && !s.processAlive && (
            <button className="btn sm" title="Put the task's uncommitted work in a named git stash (nothing is deleted), list it as deferred, and let the next Run choose another task"
              onClick={() => void window.api.setAside(projectId).then((r) => toast("success", r.stash ? `Task ${r.id} set aside. Its work is in git stash "${r.stash.message}".` : `Task ${r.id} set aside.`), (error) => toast("error", (error as Error).message))}>Set task aside</button>
          )}
          {activeProject && <button className="btn ghost sm" onClick={() => window.api.openPath(activeProject.path)}><Icon name="external" size="sm" />Open workspace</button>}
          {!s.elevateAvailable && kind === "attention" && s.elevateReason && <span className="sub">Elevate unavailable: {s.elevateReason}</span>}
          {!s.resolverAvailable && !s.assessmentRetry && kind === "blocked" && s.resolverReason && <span className="sub">Resolver unavailable: {s.resolverReason}</span>}
        </div>
      </div>
    </section>
  );
}

/** Supervisor-proposed plan edits: nothing changes until you approve; approved ones are committed between tasks. */
function PlanProposals({ projectId, refreshKey }: { projectId: string; refreshKey: string }) {
  const { toast } = useApp();
  const [list, setList] = useState<PlanProposal[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    window.api.planProposals(projectId).then((l) => live && setList(l), () => undefined);
    return () => { live = false; };
  }, [projectId, refreshKey]);
  const open = list.filter((p) => p.status === "pending" || p.status === "approved");
  if (!open.length) return null;
  const decide = (p: PlanProposal, decision: "approve" | "dismiss") => {
    setBusy(p.id);
    window.api.decidePlanProposal(projectId, p.id, decision).then(setList, (error) => toast("error", (error as Error).message)).finally(() => setBusy(null));
  };
  return (
    <section className="card pad stack fade-in" style={{ gap: 12 }} aria-label="Plan proposals">
      <div className="row" style={{ gap: 8 }}>
        <Icon name="warn" className="attn" />
        <h2 className="h2" style={{ margin: 0 }}>Supervisor plan proposals</h2>
      </div>
      <p className="sub" style={{ margin: 0 }}>Edits to <span className="mono">IMPLEMENTATION_PLAN.md</span>. Nothing changes until you approve; an approved change is committed on its own between tasks (right away when the engine is idle and the workspace is clean).</p>
      {open.map((p) => (
        <div key={p.id} className="well pad stack" style={{ gap: 8 }}>
          <div className="row wrap" style={{ gap: 8 }}>
            <b className="grow" style={{ fontWeight: 600 }}>{p.reason || "Plan edit"}</b>
            <span className="sub">{clock(p.at)}</span>
          </div>
          <pre className="mono log selectable" style={{ maxHeight: 200, margin: 0, whiteSpace: "pre-wrap" }}>
            {p.preview.split("\n").map((line, i) => (
              <div key={i} className={line.startsWith("+ ") ? "ok" : line.startsWith("- ") ? "err" : line.startsWith("@@") ? "mut" : undefined}>{line}</div>
            ))}
          </pre>
          {p.applies === false && <span className="sub err">No longer fits the plan: {p.problem}</span>}
          <div className="row wrap" style={{ gap: 10 }}>
            {p.status === "approved"
              ? <span className="sub">Approved · waiting for the next task boundary</span>
              : <button className="btn primary sm" disabled={busy === p.id || p.applies === false} onClick={() => decide(p, "approve")}>Approve</button>}
            <button className="btn sm" disabled={busy === p.id} onClick={() => decide(p, "dismiss")}>{p.status === "approved" ? "Cancel" : "Dismiss"}</button>
          </div>
        </div>
      ))}
    </section>
  );
}

function lastApproval(events: EngineEvent[]) {
  return [...events].reverse().find((e) => e.type === "qa-pass");
}

function eventLine(e: EngineEvent): string {
  return `${clock(e.timestamp)}  ${describeEvent(e)}`;
}

function PlanTree({ phases, current, activeTitle }: { phases: PlanPhase[]; current: number | null; activeTitle: string | null }) {
  const [open, setOpen] = useState<Record<number, boolean>>({});
  const isOpen = (n: number) => open[n] ?? n === current;
  const kindOf = (p: PlanPhase): StatusKind => (p.total && p.completed === p.total ? "done" : p.number === current ? "active" : p.completed ? "part" : "pending");
  return (
    <section className="card" aria-label="Implementation plan">
      <div className="row" style={{ padding: "16px 18px 8px" }}>
        <h2 className="h2">Implementation plan</h2>
        <span className="grow" />
        <button className="btn sm" onClick={() => setOpen({})}>Focus current phase</button>
      </div>
      <div className="stack" style={{ padding: "4px 12px 14px", gap: 4 }}>
        {phases.map((p) => (
          <div key={p.number}>
            <button className={`tree-btn ${p.number === current ? "cur" : ""}`} onClick={() => setOpen({ ...open, [p.number]: !isOpen(p.number) })} aria-expanded={isOpen(p.number)}>
              <Icon name="chevronRight" size="sm" className={`chev ${isOpen(p.number) ? "open" : ""}`} />
              <St kind={kindOf(p)} />
              <span className="grow" style={{ fontWeight: 600 }}>Phase {p.number} · {p.title}</span>
              <span className="sub mono">{p.completed}/{p.total}</span>
            </button>
            {isOpen(p.number) && (
              <div className="fade-in stack" style={{ gap: 2, padding: "2px 0 6px" }}>
                {p.tasks.length === 0 && <div className="sub" style={{ padding: "4px 12px 4px 60px" }}>No checklist items in this phase.</div>}
                {p.tasks.map((t, i) => {
                  const cur = !t.completed && activeTitle != null && t.title.toLowerCase().includes(activeTitle.toLowerCase().slice(0, 24));
                  return (
                    <div key={i} className={`task ${cur ? "cur" : ""}`} style={{ paddingLeft: 60 + t.depth * 20 }}>
                      <St kind={t.completed ? "done" : cur ? "active" : "pending"} />
                      <span className="grow">{t.title}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function checkKind(value: string): StatusKind {
  const v = value.toUpperCase();
  if (v === "PASS") return "done";
  if (v === "FAIL") return "blocked";
  if (v === "RUNNING") return "active";
  if (v === "INCONCLUSIVE") return "part";
  return "pending";
}

export function ProgressTab() {
  const { activeProject, activeStatus: s, snap } = useApp();
  // Implementation runs on Cline or OpenCode (local or cloud provider), Codex or Claude Code; label the step with the agent's CLI.
  const impl = agentForRoleClient("implementation", activeProject, snap.agents);
  const implCli = snap.clis.find((c) => c.id === impl?.cliId);
  const providerName = impl?.providerCliId ? snap.clis.find((c) => c.id === impl.providerCliId)?.name : impl?.provider === "ollama" ? "Ollama" : impl?.provider === "openai" ? "OpenAI-compatible" : "llama.cpp";
  const implLabel = !impl ? "No agent assigned" : implCli?.kind === "cline" || implCli?.kind === "opencode" ? `${implCli.name} · ${providerName ?? "provider"}${impl.model ? ` · ${impl.model}` : ""}` : `${implCli?.name ?? "CLI"} · ${impl.model || "CLI default"}`;
  const elevationAfter = snap.settings.advanced.engineGuardrails === false ? snap.settings.tuning.elevationAfter : 3;
  const [log, setLog] = useState<string | null>(null);
  const [runs, setRuns] = useState<RunReport[]>([]);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!activeProject) return;
    let live = true;
    window.api.runs(activeProject.id).then((r) => live && setRuns(r), () => {});
    return () => { live = false; };
  }, [activeProject, s?.processAlive]);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  if (!activeProject) return null;
  if (!s) return <div className="well pad stack" style={{ gap: 12 }}><div className="skel" style={{ width: "40%" }} /><div className="skel" style={{ width: "80%" }} /><div className="skel" style={{ width: "60%" }} /></div>;

  const plan = s.plan;
  const curPhase = plan.phases.find((p) => p.number === plan.currentPhase);
  const approval = lastApproval(s.events);
  const elapsedMs = s.clineStartedAt && s.clineStatus === "running" ? Date.now() - new Date(s.clineStartedAt).getTime() : s.clineElapsedMs;
  const activeIndex = CYCLE.findIndex((c) => c.key === s.cycle);
  const paused = ["paused", "pausing"].includes(s.runState);
  const noRuns = !s.task && s.events.length === 0;
  // Finished: the engine is not running and either reported "Objective complete" or stopped/idled with every plan item checked.
  // Attention, blocked, paused and waiting states never count, and nothing below changes while a run is active.
  const planDone = plan.total > 0 && plan.completed >= plan.total;
  const finished = !s.processAlive && (s.runState === "complete" || (planDone && (s.runState === "idle" || s.runState === "stopped")));

  return (
    <div className="stack" style={{ gap: 20 }}>
      <AttentionPanel s={s} projectId={activeProject.id} />
      <PlanProposals projectId={activeProject.id} refreshKey={`${s.events.length}:${s.events.at(-1)?.timestamp ?? ""}`} />

      {approval && s.runState !== "attention" && (
        <section className="card pad row wrap fade-in" style={{ gap: 16 }} aria-label="Last approved task">
          <span className="st done" />
          <div className="grow">
            <div style={{ fontWeight: 600 }}>Last approved: {approval.taskId}</div>
            <div className="sub">QA passed{typeof approval.attempt === "number" ? ` after ${plural(approval.attempt, "attempt")}` : ""} at {clock(approval.timestamp)}{s.git.head ? ` · HEAD ${s.git.head.slice(0, 7)}` : ""}</div>
          </div>
          {s.processAlive && !s.control.pauseAfterCurrent && <span className="sub">Automatic continuation: next task follows</span>}
        </section>
      )}

      <section className="card pad" aria-label="Overall progress" style={{ display: "grid", gridTemplateColumns: "auto minmax(0, 1.3fr) minmax(0, 1fr) auto", gap: 28, alignItems: "center" }}>
        <div>
          <div className="sub">Overall</div>
          <div style={{ fontSize: 26, fontWeight: 600 }}>{plan.percent != null ? `${plan.percent}%` : "—"}</div>
        </div>
        <div className="stack">
          <Bar pct={plan.percent ?? 0} large />
          <div className="row sub">
            {plan.total ? <span><b style={{ color: "var(--t)", fontWeight: 600 }}>{plan.completed}</b> of {plan.total} plan items complete</span> : <span>{plan.error ?? "No plan items"}</span>}
            <span className="grow" />
            {plan.total ? <span>{plan.total - plan.completed} remaining</span> : null}
          </div>
          {(() => {
            if (!plan.total) return null;
            const remaining = plan.total - plan.completed;
            const hrs = (h: number) => (h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : `${h.toFixed(1)} h`);
            const text = (e: { hours: number; tokens: number; costUsd: number }) => `about ${hrs(e.hours)} · ${tokens(Math.round(e.tokens))} tokens${e.costUsd ? ` · ${e.costUsd.toFixed(2)}` : ""}`;
            // Per task size, from runs that checked off plan items (0.35 on); otherwise per approved task.
            const byMode = modeEstimates(remaining, runs);
            const current = taskModeOf({ ...snap.settings.workflow, ...activeProject?.workflowOverrides });
            const modes = TASK_MODES.filter((m) => byMode[m.mode]);
            if (modes.length) {
              return (
                <div className="sub" title="At this project's pace per finished plan item, from its recent runs in each task size.">
                  Estimate for the rest: {modes.map((m, i) => <span key={m.mode}>{i ? " · " : ""}<b style={{ fontWeight: m.mode === current ? 600 : 400 }}>{m.label}</b> {text(byMode[m.mode]!)}</span>)}
                </div>
              );
            }
            const est = planEstimate(remaining, runs);
            if (!est) return null;
            return <div className="sub" title={`At this project's pace over its last ${plural(est.basisTasks, "approved task")}; each plan item counted as one task.`}>Estimate for the rest: {text(est)}</div>;
          })()}
        </div>
        {!curPhase && planDone && finished ? (
          <div className="stack">
            <div className="row sub">
              <span className="ellipsis">All phases complete</span>
              <span className="grow" />
              <span>{plan.phases.length} / {plan.phases.length}</span>
            </div>
            <Bar pct={100} large />
          </div>
        ) : (
        <div className="stack">
          <div className="row sub">
            <span className="ellipsis">{curPhase ? <>Phase {curPhase.number} of {plan.phases.length} · <span style={{ color: "var(--t)" }}>{curPhase.title}</span></> : "No current phase"}</span>
            <span className="grow" />
            {curPhase && <span>{curPhase.completed} / {curPhase.total}</span>}
          </div>
          <Bar pct={curPhase?.percent ?? 0} large />
        </div>
        )}
        <div className="sub" style={{ textAlign: "right" }}>
          Plan source
          <br />
          <span className="mono" style={{ color: "var(--t-soft, #b9c7d8)" }}>{plan.error ? "not found" : plan.source}</span>
        </div>
      </section>

      <section className="card pad stack" aria-label="Automation workflow" style={{ gap: 14 }}>
        <div className="row">
          <h2 className="h2">Automation cycle</h2>
          {s.attempt > 0 && <span className="chip mut">Attempt {s.attempt}</span>}
          <span className="grow" />
          <span className="sub" data-tip="Elevation is optional: it runs on a manual-review case when automatic elevation is enabled, or when you click Elevate. The Resolver handles blocked cases.">Elevation: optional</span>
        </div>
        <div className="row" style={{ gap: 8, alignItems: "stretch", overflowX: "auto", padding: "6px 6px 8px" }}>
          {CYCLE.map((c, i) => {
            // After a finished run every stage of the loop has run except Correction, which only follows a failed QA.
            const doneAfterRun = finished && c.key !== "correction";
            const active = !finished && i === activeIndex;
            const cls = finished ? (doneAfterRun ? "done" : "") : active ? (paused ? "paused" : "active") : activeIndex >= 0 && i > activeIndex ? "next" : activeIndex < 0 ? "next" : "";
            const kind: StatusKind = finished ? (doneAfterRun ? "done" : "pending") : active ? (paused ? "paused" : s.processAlive ? "active" : "pending") : activeIndex >= 0 && i < activeIndex ? "done" : "pending";
            return (
              <Fragment key={c.key}>
                <div className={`stage ${cls}`}>
                  <div className="row" style={{ gap: 8 }}>
                    <St kind={kind} />
                    <span style={{ fontWeight: 600 }}>{c.name}</span>
                  </div>
                  <div className="sub">{c.key === "implementation" ? implLabel : c.agent}</div>
                  {active && <div style={{ fontSize: 12, color: "var(--t-soft, #b9c7d8)" }}>{s.activeModel ?? s.label}</div>}
                </div>
                {i < CYCLE.length - 1 && <span className="arrow" aria-hidden="true"><Icon name="chevronRight" /></span>}
              </Fragment>
            );
          })}
        </div>
        <div>
          <div className="loop" aria-hidden="true" />
          <div className="loop-l">A failed QA returns a bounded correction to Implementation; after {elevationAfter} correction{elevationAfter === 1 ? "" : "s"} without success, Elevation reassesses the strategy</div>
        </div>
        <div className="well row wrap" style={{ padding: "12px 14px", gap: 20, fontSize: 12.5, borderRadius: "var(--radius-well-sm, 12px)" }}>
          <span><span className="sub">Stage</span> {engineStageLabel(s.stage)}</span>
          <span><span className="sub">Agent</span> {s.activeRole ?? "—"}</span>
          <span><span className="sub">Status</span> <span className={s.processAlive ? "ok" : "mut"}>{s.label}</span></span>
          <span><span className="sub">Implementation elapsed</span> <span className={elapsedMs != null && Number.isFinite(elapsedMs) ? "mono" : undefined}>{duration(elapsedMs)}</span></span>
          <span className="grow ellipsis" style={{ minWidth: 240 }}><span className="sub">Latest outcome</span> {s.latestQa ? s.latestQa.split(/\r?\n/)[0] : "—"}</span>
        </div>
      </section>

      {(
        <div className="grid2">
          {plan.phases.length ? (
            <PlanTree phases={plan.phases} current={plan.currentPhase} activeTitle={s.task?.name ?? null} />
          ) : (
            <section className="card pad stack" style={{ gap: 8 }}>
              <h2 className="h2">Implementation plan</h2>
              <p className="sub" style={{ margin: 0 }}>{plan.error ?? "The plan has no phases."} Add <span className="mono">IMPLEMENTATION_PLAN.md</span> with <span className="mono">## Phase N — Title</span> headings and checkboxes to track progress.</p>
            </section>
          )}

          <section className="card pad stack" aria-label="Current task" style={{ gap: 16 }}>
            {finished ? (
              <div className="stack" style={{ gap: 8, alignItems: "flex-start" }}>
                <div className="row" style={{ gap: 8 }}>
                  <St kind="done" title="Finished" />
                  <h2 className="h2">{s.runState === "complete" ? "Objective complete" : "Plan complete"}</h2>
                </div>
                <span className="sub">
                  No current task. {planDone ? (plan.total === 1 ? "The plan item is checked off." : `All ${plan.total} plan items are checked off.`) : "The engine reported the objective as done."}
                  {approval ? ` Last approved: ${approval.taskId} at ${clock(approval.timestamp)}.` : ""}
                  {" "}Press Run to let Assessment look for more work.
                </span>
              </div>
            ) : s.task ? (
              <>
                <div>
                  <div className="row">
                    <span className="mono mut">{s.task.id}</span>
                    {s.attempt > 0 && <span className="chip info">Attempt {s.attempt}</span>}
                  </div>
                  <h2 className="h2" style={{ marginTop: 6 }}>{s.task.name}</h2>
                </div>
                <Disclosure title="Task prompt" meta={`${s.task.prompt.length} chars`}>
                  <div className="mono log selectable">{s.task.prompt}</div>
                </Disclosure>
                <dl className="kv two">
                  <div><dt>Implementation</dt><dd>{implLabel}</dd></div>
                  <div><dt>Current operation</dt><dd>{s.activeRole ?? (s.processAlive ? "Between steps" : "—")}</dd></div>
                  <div><dt>QA command</dt><dd className={s.task.qaCommand ? "mono" : undefined} title={s.task.qaCommand}>{s.task.qaCommand || "—"}</dd></div>
                  <div><dt>Context</dt><dd>{s.contextTokens ? `${num(s.contextTokens)} tokens` : "—"}</dd></div>
                </dl>
                <div className="well" style={{ padding: "12px 14px", borderRadius: "var(--radius-well-sm, 12px)" }}>
                  <div className="eyebrow" style={{ marginBottom: 6 }}>QA checks</div>
                  <ul className="list">
                    {Object.entries(s.qaChecks).map(([k, v]) => (
                      <li key={k}><St kind={checkKind(String(v))} title={sentenceCase(String(v))} /><span className="grow">{k === "scopeCheck" ? "Scope check" : k[0].toUpperCase() + k.slice(1)}</span><span className="sub">{sentenceCase(String(v))}</span></li>
                    ))}
                  </ul>
                  <div className="eyebrow" style={{ margin: "12px 0 6px" }}>Approved paths</div>
                  <ul className="list">
                    {!(s.task.allowedPaths ?? []).length && <li className="sub">No approved paths</li>}
                    {(s.task.allowedPaths ?? []).map((p) => {
                      const change = s.git.changedFiles.find((f) => f.path === p.replaceAll("\\", "/"));
                      return <li key={p}><span className="mono grow">{p}</span><span className={`chip ${change ? "warn" : "mut"}`}>{change ? change.status.trim() || "changed" : "unchanged"}</span></li>;
                    })}
                  </ul>
                  {s.git.changedFiles.some((f) => !(s.task!.allowedPaths ?? []).map((p) => p.replaceAll("\\", "/")).includes(f.path)) && (
                    <div className="row warn" style={{ marginTop: 8, fontSize: 12 }}><Icon name="warn" size="sm" />Files outside the approved paths have changed. QA will reject them.</div>
                  )}
                </div>
                {s.latestQa && (
                  <Disclosure title="Latest QA output">
                    <div className="mono log selectable">{s.latestQa}</div>
                  </Disclosure>
                )}
              </>
            ) : noRuns ? (
              <div className="stack" style={{ gap: 8, alignItems: "flex-start" }}>
                <h2 className="h2">No automation has run for this project yet</h2>
                <span className="sub">{activeProject.objective ? "Press Run to start. Assessment picks the first bounded task from the objective." : "Set an objective in the prompt bar (Ctrl+K), then press Run."}</span>
              </div>
            ) : (
              <div className="sub">No task loaded yet. Assessment chooses the first bounded task when the engine starts.</div>
            )}
            <Disclosure title="Activity" meta={`${s.events.length} recent events`}>
              <div className="mono log selectable">{s.events.filter((e) => !isHiddenEvent(e)).slice(-60).map(eventLine).join("\n") || "No activity yet."}</div>
            </Disclosure>
            <div>
              <button className="disc" onClick={async () => setLog(log === null ? await window.api.engineLog(activeProject.id) : null)} aria-expanded={log !== null}>
                <Icon name="chevronRight" size="sm" className={`chev ${log !== null ? "open" : ""}`} />
                Engine log
                <span className="grow" />
                <span className="sub">{s.processAlive ? <><Dot tone="ok" live /> live</> : "last run"}</span>
              </button>
              {log !== null && <div className="mono log selectable fade-in">{log || "No engine output yet."}</div>}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
