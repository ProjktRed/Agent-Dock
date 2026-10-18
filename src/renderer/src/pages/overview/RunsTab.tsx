import { Fragment, useEffect, useState } from "react";
import type { RunReport } from "@shared/types";
import { useApp } from "../../store";
import { ago, tokens } from "../../lib/format";
import { Empty, St, type StatusKind } from "../../components/ui";

const tone = (r: RunReport): StatusKind => (r.status === "done" ? "done" : r.status === "blocked" ? "blocked" : r.needsAttention ? "attn" : "paused");
const hours = (h: number) => (h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : `${h.toFixed(1)} h`);

/** Finished runs: what each achieved, why it ended, what it cost, and whether its action log verified. */
export function RunsTab() {
  const { activeProject, activeStatus } = useApp();
  const [runs, setRuns] = useState<RunReport[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const alive = activeStatus?.processAlive;
  useEffect(() => {
    if (!activeProject) return;
    let live = true;
    window.api.runs(activeProject.id).then((r) => live && setRuns(r), () => live && setRuns([]));
    return () => { live = false; };
  }, [activeProject, alive]);
  if (!runs) return <div className="well pad"><div className="skel" style={{ width: "50%" }} /></div>;
  if (!runs.length) return <Empty title="No finished runs yet" icon="list"><span>Each run that ends (done, stopped, a limit, or blocked) is listed here with its report.</span></Empty>;
  const total = runs.reduce((a, r) => ({ tasks: a.tasks + r.tasksApproved, tokens: a.tokens + (r.usage?.tokens ?? 0), cost: a.cost + (r.usage?.costUsd ?? 0) }), { tasks: 0, tokens: 0, cost: 0 });
  return (
    <section className="card" aria-label="Runs">
      <div className="row wrap" style={{ gap: 18, padding: "16px 18px 6px" }}>
        <h2 className="h2 grow" style={{ margin: 0 }}>Runs</h2>
        <span className="sub">{runs.length} run(s) · {total.tasks} task(s) approved · {tokens(total.tokens)} tokens · ${total.cost.toFixed(2)} reported spend</span>
      </div>
      <div className="scroll-x" style={{ padding: "0 6px 8px" }}>
        <table className="tbl" style={{ minWidth: 820 }}>
          <thead><tr><th>Started</th><th>Length</th><th>Result</th><th>Why it ended</th><th className="num">Approved</th><th className="num">QA fails</th><th className="num">Tokens</th><th className="num">Spend</th><th>Log</th></tr></thead>
          <tbody>
            {runs.map((r) => (
              <Fragment key={r.startedAt}>
                <tr className={`click${open === r.startedAt ? " sel" : ""}`} onClick={() => setOpen(open === r.startedAt ? null : r.startedAt)}>
                  <td title={new Date(r.startedAt).toLocaleString()}>{ago(r.startedAt)}{r.unattended ? <span className="sub"> · unattended</span> : null}</td>
                  <td>{hours(r.hours)}</td>
                  <td><span className="row" style={{ gap: 6 }}><St kind={tone(r)} />{r.status}</span></td>
                  <td className="ellipsis" style={{ maxWidth: 280 }} title={r.reason ?? ""}>{(r.reason ?? "").split(/\r?\n/)[0] || "finished"}</td>
                  <td className="num">{r.tasksApproved}</td>
                  <td className="num">{r.qaFailures}</td>
                  <td className="num">{tokens(r.usage?.tokens ?? 0)}</td>
                  <td className="num">{r.usage?.costUsd ? `$${r.usage.costUsd.toFixed(2)}` : "—"}</td>
                  <td>{r.actionLog?.ok ? <span className="ok">verified</span> : <span className="err" title={r.actionLog?.reason}>not verified</span>}</td>
                </tr>
                {open === r.startedAt && (
                  <tr>
                    <td colSpan={9}>
                      <div className="stack" style={{ gap: 6 }}>
                        <span className="sub">{new Date(r.startedAt).toLocaleString()} → {new Date(r.endedAt).toLocaleString()} · corrections {r.corrections} · Elevations {r.elevations} · stops for attention {r.needsAttention} · Supervisor alerts {r.supervisorAlerts} · {r.usage?.calls ?? 0} model call(s), {tokens(r.usage?.cached ?? 0)} more tokens read from prompt caches</span>
                        {r.approved?.length ? <span className="sub">Approved: {r.approved.map((a) => a.taskId ?? "task").join(", ")}</span> : null}
                        {r.reason && r.reason.includes("\n") ? <div className="mono log" style={{ maxHeight: 120 }}>{r.reason}</div> : null}
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
