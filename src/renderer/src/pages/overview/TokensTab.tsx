import { useEffect, useMemo, useState } from "react";
import type { LocalContext, TokenRecord, UsageSummary } from "@shared/types";
import { useApp } from "../../store";
import { duration, roleLabel, tokens } from "../../lib/format";
import { agentForRoleClient } from "../../lib/agents";
import { Bar, Empty, ProvenanceChip, Tabs, Toggle } from "../../components/ui";

type Range = "task" | "session" | "day" | "week" | "month";
type Scope = "cloud" | "local";
const ROLES: TokenRecord["role"][] = ["implementation", "qa", "assessment", "elevation", "resolver", "custom"];
const SW: Record<TokenRecord["role"], string> = { implementation: "c1", qa: "c2", assessment: "c3", elevation: "c4", resolver: "c5", custom: "c6" };

function bucketise(records: TokenRecord[], range: Range, since: number) {
  const span = Date.now() - since;
  const n = range === "week" ? 7 : range === "month" ? 15 : 12;
  const size = Math.max(span / n, 60_000);
  const buckets = Array.from({ length: n }, (_, i) => ({ start: since + i * size, roles: {} as Record<string, number> }));
  for (const r of records) {
    const i = Math.min(n - 1, Math.floor((new Date(r.timestamp).getTime() - since) / size));
    if (i < 0) continue;
    buckets[i].roles[r.role] = (buckets[i].roles[r.role] ?? 0) + r.input + r.output;
  }
  const label = (t: number) => {
    const d = new Date(t);
    return range === "week" || range === "month" ? d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  };
  return buckets.map((b) => ({ ...b, label: label(b.start) }));
}

/** Live occupancy of the local Implementation agent's context, polled while the Local AI tab is open. */
function useLocalContext(projectId: string | null, enabled: boolean) {
  const [ctx, setCtx] = useState<LocalContext | null>(null);
  useEffect(() => {
    if (!projectId || !enabled) return;
    let live = true;
    const load = () => window.api.localContext(projectId).then((c) => live && setCtx(c)).catch(() => {});
    void load();
    const t = setInterval(load, 5_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [projectId, enabled]);
  return ctx;
}

export function TokensTab() {
  const { activeProject, activeStatus, snap, healths } = useApp();
  const [allProjects, setAllProjects] = useState(false);
  const [range, setRange] = useState<Range>(activeStatus?.processAlive ? "session" : "month");
  const [scopePick, setScope] = useState<Scope>("cloud");
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  // Local AI is hooked up when the project's Implementation agent runs Cline on llama.cpp or Ollama.
  const impl = activeProject ? agentForRoleClient("implementation", activeProject, snap.agents) : null;
  const implKind = snap.clis.find((c) => c.id === impl?.cliId)?.kind;
  const localHooked = Boolean(impl && implKind === "cline" && impl.provider);
  const scope: Scope = localHooked ? scopePick : "cloud";
  const localCtx = useLocalContext(activeProject?.id ?? null, scope === "local");
  useEffect(() => {
    let live = true;
    const load = () => window.api.usage(allProjects ? null : activeProject?.id ?? null).then((u) => live && setUsage(u));
    void load();
    const t = setInterval(load, 15_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [allProjects, activeProject?.id]);

  const since = useMemo(() => {
    const now = Date.now();
    if (range === "task") {
      const start = [...(activeStatus?.events ?? [])].reverse().find((e) => e.type === "task-loaded" || e.type === "task-start");
      return start ? new Date(start.timestamp).getTime() : now - 3_600_000;
    }
    if (range === "session") return usage?.sessionStartedAt ? new Date(usage.sessionStartedAt).getTime() : now - 6 * 3_600_000;
    return now - { day: 86_400_000, week: 7 * 86_400_000, month: 30 * 86_400_000 }[range];
  }, [range, usage?.sessionStartedAt, activeStatus?.events]);

  if (!activeProject) return null;
  if (!usage) return <div className="well pad stack" style={{ gap: 12 }}><div className="skel" style={{ width: "50%" }} /><div className="skel" style={{ width: "70%" }} /></div>;

  const local = scope === "local";
  const records = usage.records.filter((r) => Boolean(r.local) === local);
  const inRange = records.filter((r) => new Date(r.timestamp).getTime() >= since);
  const sessionRecords = usage.sessionStartedAt ? records.filter((r) => r.timestamp >= usage.sessionStartedAt!) : records;
  const sum = (rs: TokenRecord[], k: "input" | "cached" | "output") => rs.reduce((n, r) => n + r[k], 0);
  const statsSource = usage.sessionStartedAt ? sessionRecords : records;
  const byRole = ROLES.map((role) => {
    const rs = statsSource.filter((r) => r.role === role);
    return { role, rs, input: sum(rs, "input"), output: sum(rs, "output"), cached: sum(rs, "cached") };
  }).filter((x) => x.rs.length);
  const buckets = bucketise(inRange, range, since);
  const maxBucket = Math.max(1, ...buckets.map((b) => Object.values(b.roles).reduce((a, v) => a + v, 0)));
  const compare = ROLES.map((role) => ({ role, total: inRange.filter((r) => r.role === role).reduce((n, r) => n + r.input + r.output, 0) })).filter((c) => c.total);
  const maxCompare = Math.max(1, ...compare.map((c) => c.total));

  const providerCli = snap.clis.find((c) => impl && c.kind === impl.provider);
  const modelMax = providerCli ? healths[providerCli.id]?.contextMax : undefined;
  const orchKind = snap.clis.find((c) => c.id === agentForRoleClient("qa", activeProject, snap.agents)?.cliId)?.kind;
  // Orchestrator invocations don't record a model: show the role's configured agent model, else the engine default.
  const modelFor = (r: (typeof byRole)[number]) => {
    const recorded = r.rs.at(-1)?.model;
    if (recorded) return recorded;
    if (r.role === "implementation") return impl?.model || "CLI default";
    if (r.role === "custom") return "Per role";
    const configured = agentForRoleClient(r.role === "resolver" ? "assessment" : r.role, activeProject, snap.agents)?.model;
    if (configured) return configured;
    const models = r.rs.at(-1)?.provider.startsWith("Anthropic") ? snap.engine.orchestratorModels.claude : snap.engine.orchestratorModels.codex;
    return models[r.role === "elevation" ? "elevate" : r.role] ?? "—";
  };
  const warnAt = snap.settings.context.warnThresholdPercent;
  // Occupancy is measured against the server's real slot size when llama.cpp reports it.
  const ctxSize = localCtx?.size ?? impl?.contextTokens ?? 0;
  const occupancyPct = localCtx?.used && ctxSize ? Math.min(100, (localCtx.used / ctxSize) * 100) : 0;

  return (
    <div className="stack" style={{ gap: 20 }}>
      {localHooked && (
        <Tabs<Scope> label="Token source" small value={scope} onChange={setScope} options={[
          { value: "cloud", label: "Cloud AI" },
          { value: "local", label: `Local AI · ${impl?.provider === "ollama" ? "Ollama" : "llama.cpp"}` },
        ]} />
      )}
      <section className="well stats" aria-label={usage.sessionStartedAt ? "Current session" : "All recorded runs"}>
        <div className="stat"><span className="sub">Input tokens</span><b>{tokens(sum(statsSource, "input"))}</b></div>
        <div className="stat">
          <span className="sub"><span data-tip={local ? "llama.cpp and Ollama do not report prompt-cache hits per request." : "Input tokens served from a prompt cache. Already counted inside Input. Reported by Codex and Claude Code."}>Cached</span></span>
          <b className={local ? "mut" : ""} style={local ? { fontSize: 14 } : undefined}>{local ? "Not reported" : tokens(sum(statsSource, "cached"))}</b>
        </div>
        <div className="stat"><span className="sub">Output tokens</span><b>{tokens(sum(statsSource, "output"))}</b></div>
        <div className="stat"><span className="sub">Total (input + output)</span><b>{tokens(sum(statsSource, "input") + sum(statsSource, "output"))}</b></div>
        <div className="stat">
          <span className="sub"><span data-tip={local ? "Runs on your own hardware." : "No per-token pricing is configured, and subscription CLIs do not expose a per-token price, so no cost is estimated."}>{local ? "Cost" : "Estimated cost"}</span></span>
          <b className="mut" style={{ fontSize: 14 }}>{local ? "Local" : "Not priced"}</b>
        </div>
        <div className="stat"><span className="sub">{usage.sessionStartedAt ? "Session duration" : "Scope"}</span><b>{usage.sessionStartedAt ? duration(Date.now() - new Date(usage.sessionStartedAt).getTime()) : <span style={{ fontSize: 14 }}>All runs</span>}</b></div>
      </section>

      <div className="grid2" style={{ gridTemplateColumns: "minmax(0, 1.25fr) minmax(0, 1fr)" }}>
        <section className="card" aria-label="Per-agent usage">
          <div className="row" style={{ padding: "16px 18px 6px" }}>
            <h2 className="h2">Per-agent usage</h2>
            <span className="grow" />
            <span className="sub">{usage.sessionStartedAt ? "This session" : "All recorded runs"}</span>
          </div>
          {byRole.length === 0 ? (
            <div className="sub" style={{ padding: "8px 18px 18px" }}>
              {local ? "No local usage yet. llama.cpp usage is sampled every 30 s while the worker runs." : "No cloud usage yet. Codex and Claude Code report usage when each call finishes."}
            </div>
          ) : (
            <div className="scroll-x" style={{ padding: "0 6px 8px" }}>
              <table className="tbl" style={{ minWidth: 640 }}>
                <thead><tr><th>Agent role</th><th>Model · provider</th><th className="num">Input</th><th className="num">Output</th><th className="num">Total</th><th className="num">Cost</th></tr></thead>
                <tbody>
                  {byRole.map((r) => (
                    <tr key={r.role}>
                      <td><span className="row" style={{ gap: 8 }}><span className={`sw ${SW[r.role]}`} />{roleLabel[r.role]}</span></td>
                      <td><div className="mono">{modelFor(r)}</div><div className="sub">{r.rs[0].provider}</div></td>
                      <td className="num">{tokens(r.input)}</td>
                      <td className="num">{tokens(r.output)}</td>
                      <td className="num" style={{ fontWeight: 600 }}>{tokens(r.input + r.output)}</td>
                      <td className="num mut">{local ? "Local" : "Not priced"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="card pad stack" aria-label="Context utilization" style={{ gap: 16 }}>
          <div className="row">
            <h2 className="h2">Context</h2>
            <span className="grow" />
            <span className="sub" data-tip="Session totals are cumulative tokens processed. Occupancy is what fills the model's context window right now.">Not the session total</span>
          </div>
          {local && impl ? (
            <div className="stack" style={{ gap: 7 }}>
              <div className="row" style={{ fontSize: 12.5 }}><span style={{ fontWeight: 600 }}>{impl.name}</span><span className="grow" /><span className="mono">{tokens(ctxSize)}</span><span className="sub">{localCtx?.size ? "server context" : "configured"}</span></div>
              <div className="ctx" role="img" aria-label={`Context occupancy ${Math.round(occupancyPct)}%`}>
                <span className="cfg" style={{ width: "100%", opacity: 0.35 }} />
                {localCtx?.used ? <span className={`used ${occupancyPct >= warnAt ? "hot" : ""}`} style={{ width: `${occupancyPct}%` }} /> : null}
              </div>
              <div className="row sub" style={{ fontSize: 11.5, gap: 8 }}>
                <span>
                  {!localCtx
                    ? "Reading occupancy…"
                    : localCtx.used
                      ? `${localCtx.state === "processing" ? "In use now" : "Held from the last request"}: ${tokens(localCtx.used)} of ${tokens(ctxSize)} (${Math.round(occupancyPct)}%)`
                      : localCtx.state === "not-reported"
                        ? "Current occupancy: not reported by Ollama"
                        : localCtx.state === "idle"
                          ? "Idle: nothing in the context yet"
                          : `Occupancy unavailable: ${localCtx.source}`}
                </span>
                <span className="grow" />
                {localCtx?.used ? <ProvenanceChip value="reported" /> : null}
              </div>
              <div className="row sub" style={{ fontSize: 11.5 }}>
                <span>Configured {tokens(impl.contextTokens)}</span>
                <span className="grow" />
                <span>Model max {modelMax?.value ? tokens(modelMax.value) : "unknown"}</span>
                {modelMax && <ProvenanceChip value={modelMax.provenance} />}
              </div>
              {modelMax?.value && impl.contextTokens > modelMax.value && <div className="row warn" style={{ fontSize: 12 }}>Configured context exceeds the model's reported maximum.</div>}
              {occupancyPct >= warnAt && <div className="row warn" style={{ fontSize: 12 }}>Context is {Math.round(occupancyPct)}% full; Cline compacts its history when it runs out.</div>}
              <div className="row" style={{ fontSize: 12.5 }}>
                <span className="grow">Compactions recorded</span>
                <span className={usage.compactions ? "warn" : "mut"}>{usage.compactions}</span>
              </div>
            </div>
          ) : (
            <div className="sub">
              {orchKind === "claude" ? "Claude Code" : "Codex CLI"} manages QA, Assessment and Elevation context{implKind === "codex" || implKind === "claude" ? ", and the Implementation agent's," : ""} inside the CLI; it is not exposed.
            </div>
          )}
        </section>
      </div>

      <section className="card pad stack" aria-label="Usage history" style={{ gap: 16 }}>
        <div className="row wrap" style={{ gap: 14 }}>
          <h2 className="h2">Usage history</h2>
          <span className="grow" />
          <Tabs<Range> label="Time range" small value={range} onChange={setRange} options={[
            { value: "task", label: "Current task" },
            { value: "session", label: "Session" },
            { value: "day", label: "Day" },
            { value: "week", label: "Week" },
            { value: "month", label: "Month" },
          ]} />
          <label className="row sub" style={{ gap: 8 }}><Toggle on={allProjects} onChange={setAllProjects} label="Include all projects" />All projects</label>
        </div>
        {inRange.length === 0 ? (
          <Empty title={`No ${local ? "local" : "cloud"} usage in this range`} icon="terminal" />
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 2fr) minmax(220px, 1fr)", gap: 32, alignItems: "end" }}>
            <div>
              <div className="chart" role="img" aria-label="Stacked token usage by role">
                {buckets.map((b, i) => (
                  <div key={i} className="colb" title={`${b.label}: ${tokens(Object.values(b.roles).reduce((a, v) => a + v, 0))}`}>
                    {ROLES.filter((r) => b.roles[r]).map((r) => <i key={r} className={SW[r]} style={{ height: `${(b.roles[r] / maxBucket) * 150}px` }} />)}
                  </div>
                ))}
              </div>
              <div className="row sub" style={{ gap: 6, fontSize: 10.5, padding: "6px 4px 0" }}>
                {buckets.map((b, i) => <span key={i} style={{ flex: 1, textAlign: "center", minWidth: 6, overflow: "hidden" }}>{i % 2 === 0 ? b.label : ""}</span>)}
              </div>
            </div>
            <div className="stack" style={{ gap: 12 }}>
              <div className="eyebrow">Role comparison · {range}</div>
              {compare.map((c) => (
                <div key={c.role} className="stack" style={{ gap: 5 }}>
                  <div className="row" style={{ fontSize: 12.5 }}><span className={`sw ${SW[c.role]}`} /><span>{roleLabel[c.role]}</span><span className="grow" /><span className="mono">{tokens(c.total)}</span></div>
                  <Bar pct={(c.total / maxCompare) * 100} />
                </div>
              ))}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
