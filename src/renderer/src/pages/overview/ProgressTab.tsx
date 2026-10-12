import { Fragment, useEffect, useState } from "react";
import type { EngineEvent, PlanPhase, ProjectStatus } from "@shared/types";
import { useApp } from "../../store";
import { clock, duration } from "../../lib/format";
import { Icon } from "../../components/Icon";
import { Bar, Disclosure, Dot, Empty, St, type StatusKind } from "../../components/ui";

const CYCLE = [
  { key: "assessment", name: "Assessment", agent: "Plans one bounded task" },
  { key: "implementation", name: "Implementation", agent: "Cline · local model" },
  { key: "qa", name: "QA", agent: "Verifies, commits on pass" },
  { key: "correction", name: "Correction / Elevation", agent: "Only after a failed QA" },
  { key: "next", name: "Next task", agent: "Back to Assessment" },
] as const;

function AttentionPanel({ s, projectId }: { s: ProjectStatus; projectId: string }) {
  const { control, activeProject } = useApp();
  const kind = s.runState;
  if (!["attention", "blocked", "waiting-limit"].includes(kind)) return null;
  const meta = {
    attention: { title: "Attention required: manual review", tone: "attnb", text: s.attentionReason, help: "The engine stopped for your review. Elevation can propose a revised correction, which then goes through independent QA." },
    blocked: { title: "Blocked: safe continuation is not possible", tone: "errb", text: s.blockedReason, help: "Scope, HEAD, permission or state problems never continue automatically. The diff is left in place for inspection." },
    "waiting-limit": { title: "Waiting: orchestrator usage limit", tone: "warnb", text: s.limitMessage, help: "Resume reruns only the interrupted Assessment or QA operation with the same inputs." },
  }[kind as "attention" | "blocked" | "waiting-limit"];
  return (
    <section className={`banner ${meta.tone} fade-in`} role="alert" style={{ padding: 18 }}>
      <Icon name="warn" className={kind === "blocked" ? "err" : "attn"} />
      <div className="grow stack" style={{ gap: 10 }}>
        <div style={{ fontWeight: 600, color: "var(--t)" }}>{meta.title}</div>
        {meta.text && <div className="mono log" style={{ maxHeight: 140 }}>{meta.text}</div>}
        {s.limitRetryAt && <div className="sub">Provider reports retry after: {s.limitRetryAt}</div>}
        <div className="sub">{meta.help}</div>
        <div className="row wrap" style={{ gap: 10 }}>
          {s.elevateAvailable && <button className="btn primary sm" onClick={() => control(projectId, "elevate", "Elevation requested")}>Elevate</button>}
          {s.resolverAvailable && <button className="btn primary sm" onClick={() => control(projectId, "resolve", "Resolver requested")}>Resolve block</button>}
          {(kind === "waiting-limit" || kind === "attention") && <button className="btn sm" onClick={() => control(projectId, "resume", "Resumed")}>Resume</button>}
          {activeProject && <button className="btn ghost sm" onClick={() => window.api.openPath(activeProject.path)}><Icon name="external" size="sm" />Open workspace</button>}
          {!s.elevateAvailable && kind === "attention" && s.elevateReason && <span className="sub">Elevate unavailable: {s.elevateReason}</span>}
          {!s.resolverAvailable && kind === "blocked" && s.resolverReason && <span className="sub">Resolver unavailable: {s.resolverReason}</span>}
        </div>
      </div>
    </section>
  );
}

function lastApproval(events: EngineEvent[]) {
  return [...events].reverse().find((e) => e.type === "qa-pass");
}

function eventLine(e: EngineEvent): string {
  const detail = e.message ?? e.qa ?? (e.model ? `model ${e.model}` : "");
  return `${clock(e.timestamp)}  ${e.type}${e.attempt != null ? ` #${e.attempt}` : ""}${detail ? `  ${String(detail).split(/\r?\n/)[0].slice(0, 160)}` : ""}`;
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
  const { activeProject, activeStatus: s } = useApp();
  const [log, setLog] = useState<string | null>(null);
  const [, tick] = useState(0);
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

  return (
    <div className="stack" style={{ gap: 20 }}>
      <AttentionPanel s={s} projectId={activeProject.id} />

      {approval && s.runState !== "attention" && (
        <section className="card pad row wrap fade-in" style={{ gap: 16 }} aria-label="Last approved task">
          <span className="st done" />
          <div className="grow">
            <div style={{ fontWeight: 600 }}>Last approved: {approval.taskId}</div>
            <div className="sub">QA passed after {approval.attempt ?? "?"} attempt(s) at {clock(approval.timestamp)}{s.git.head ? ` · HEAD ${s.git.head.slice(0, 7)}` : ""}</div>
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
        </div>
        <div className="stack">
          <div className="row sub">
            <span className="ellipsis">{curPhase ? <>Phase {curPhase.number} of {plan.phases.length} · <span style={{ color: "var(--t)" }}>{curPhase.title}</span></> : "No current phase"}</span>
            <span className="grow" />
            {curPhase && <span>{curPhase.completed} / {curPhase.total}</span>}
          </div>
          <Bar pct={curPhase?.percent ?? 0} variant="mint" large />
        </div>
        <div className="sub" style={{ textAlign: "right" }}>
          Plan source
          <br />
          <span className="mono" style={{ color: "#b9c7d8" }}>{plan.error ? "not found" : plan.source}</span>
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
            const active = i === activeIndex;
            const cls = active ? (paused ? "paused" : "active") : activeIndex >= 0 && i > activeIndex ? "next" : activeIndex < 0 ? "next" : "";
            const kind: StatusKind = active ? (paused ? "paused" : s.processAlive ? "active" : "pending") : activeIndex >= 0 && i < activeIndex ? "done" : "pending";
            return (
              <Fragment key={c.key}>
                <div className={`stage ${cls}`}>
                  <div className="row" style={{ gap: 8 }}>
                    <St kind={kind} />
                    <span style={{ fontWeight: 600 }}>{c.name}</span>
                  </div>
                  <div className="sub">{c.agent}</div>
                  {active && <div style={{ fontSize: 12, color: "#b9c7d8" }}>{s.activeModel ?? s.label}</div>}
                </div>
                {i < CYCLE.length - 1 && <span className="arrow" aria-hidden="true"><Icon name="chevronRight" /></span>}
              </Fragment>
            );
          })}
        </div>
        <div>
          <div className="loop" aria-hidden="true" />
          <div className="loop-l">A failed QA returns a bounded correction to Implementation; every fifth attempt the strategy is reassessed</div>
        </div>
        <div className="well row wrap" style={{ padding: "12px 14px", gap: 20, fontSize: 12.5, borderRadius: 12 }}>
          <span><span className="sub">Stage</span> {s.stage}</span>
          <span><span className="sub">Agent</span> {s.activeRole ?? "—"}</span>
          <span><span className="sub">Status</span> <span className={s.processAlive ? "ok" : "mut"}>{s.label}</span></span>
          <span><span className="sub">Cline elapsed</span> <span className="mono">{duration(elapsedMs)}</span></span>
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
            {s.task ? (
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
                  <div><dt>Implementation</dt><dd>{s.clineModel ? `Cline · ${s.clineModel}` : "Cline"}</dd></div>
                  <div><dt>Current operation</dt><dd>{s.activeRole ?? (s.processAlive ? "Between steps" : "None")}</dd></div>
                  <div><dt>QA command</dt><dd className="mono" title={s.task.qaCommand}>{s.task.qaCommand ?? "—"}</dd></div>
                  <div><dt>Context</dt><dd>{s.contextTokens ? `${s.contextTokens.toLocaleString()} tokens` : "—"}</dd></div>
                </dl>
                <div className="well" style={{ padding: "12px 14px", borderRadius: 12 }}>
                  <div className="eyebrow" style={{ marginBottom: 6 }}>QA checks</div>
                  <ul className="list">
                    {Object.entries(s.qaChecks).map(([k, v]) => (
                      <li key={k}><St kind={checkKind(String(v))} title={String(v)} /><span className="grow">{k === "scopeCheck" ? "Scope check" : k[0].toUpperCase() + k.slice(1)}</span><span className="sub">{String(v)}</span></li>
                    ))}
                  </ul>
                  <div className="eyebrow" style={{ margin: "12px 0 6px" }}>Approved paths</div>
                  <ul className="list">
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
              <div className="mono log selectable">{s.events.slice(-60).map(eventLine).join("\n") || "No activity yet."}</div>
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
