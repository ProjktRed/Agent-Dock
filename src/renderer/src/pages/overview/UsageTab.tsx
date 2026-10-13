import { useEffect, useState } from "react";
import type { CliConnection, LimitWindow, LimitsState, Provenance, ProviderLimits, UsageSummary } from "@shared/types";
import { cleanError, useApp } from "../../store";
import { ago, connectionMeta, tokens } from "../../lib/format";
import { Icon } from "../../components/Icon";
import { Bar, Dot, Modal, ProvenanceChip, Spinner } from "../../components/ui";

const providerOf = (c: CliConnection) => ({ codex: "OpenAI", claude: "Anthropic", ollama: "Local runtime", llamacpp: "Local runtime", openai: "Custom provider", cline: "Multi-provider", opencode: "Implementation worker" })[c.kind];
const recordProvider = (c: CliConnection) => ({ codex: "OpenAI · Codex", claude: "Anthropic · Claude Code", llamacpp: "llamacpp · local", ollama: "ollama · local" } as Record<string, string>)[c.kind] ?? "";
const PLAN_NAMES: Record<string, string> = { plus: "ChatGPT Plus", pro: "ChatGPT Pro", prolite: "ChatGPT Pro Lite", team: "ChatGPT Team", business: "ChatGPT Business", enterprise: "ChatGPT Enterprise", edu: "ChatGPT Edu", free: "ChatGPT Free", go: "ChatGPT Go" };

/** "in 2h 14m" / "in 4d 6h" until an ISO time. */
function until(iso: string | null): string {
  if (!iso) return "";
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "resetting";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `resets in ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `resets in ${h}h ${m % 60}m`;
  return `resets in ${Math.floor(h / 24)}d ${h % 24}h`;
}

function Window({ label, provenance, text, sub, pct, variant }: { label: string; provenance: Provenance; text: string; sub?: string; pct?: number; variant?: "" | "est" | "man" }) {
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="row" style={{ fontSize: 12 }}>
        <span className="sub">{label}</span>
        <span className="grow" />
        <ProvenanceChip value={provenance} />
      </div>
      {pct != null && <Bar pct={pct} variant={variant} />}
      <div className="row" style={{ fontSize: 12 }}>
        <span>{text}</span>
        <span className="grow" />
        {sub && <span className="sub">{sub}</span>}
      </div>
    </div>
  );
}

function ReportedWindow({ w }: { w: LimitWindow }) {
  return <Window label={w.label} provenance="reported" text={`${w.usedPercent}% used`} sub={until(w.resetsAt)} pct={w.usedPercent} />;
}

function monthStart() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString();
}

export function useLimits() {
  const [state, setState] = useState<LimitsState | null>(null);
  useEffect(() => {
    void window.api.limits().then(setState);
    return window.api.onLimits(setState);
  }, []);
  return state;
}

export function UsageTab() {
  const { snap, healths, activeStatus, updateSettings, toast } = useApp();
  const limits = useLimits();
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [notes, setNotes] = useState(true);
  const [budgetOpen, setBudgetOpen] = useState(false);
  const [checksOpen, setChecksOpen] = useState(false);
  const [draft, setDraft] = useState({ provider: "codex", limit: "5000000" });
  const [, tick] = useState(0);
  useEffect(() => {
    let live = true;
    const load = () => window.api.usage(null).then((u) => live && setUsage(u));
    void load();
    const t = setInterval(load, 20_000);
    const clock = setInterval(() => tick((n) => n + 1), 30_000);
    return () => {
      live = false;
      clearInterval(t);
      clearInterval(clock);
    };
  }, []);
  const clis = snap.clis.filter((c) => c.kind !== "cline");
  const budgets = snap.settings.usage.manualBudgets;
  const orchestratorKind = snap.clis.find((c) => c.id === snap.agents.find((a) => a.role === "qa")?.cliId)?.kind;
  const refresh = (provider: "codex" | "claude") => window.api.refreshLimits(provider).catch((e) => toast("error", cleanError(e)));

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="row wrap" style={{ gap: 16 }}>
        <span className="row sub" style={{ gap: 6 }}><span className="sw c1" />Reported by provider</span>
        <span className="row sub" style={{ gap: 6 }}><span className="sw c4" />Manual tracking</span>
        <span className="row sub" style={{ gap: 6 }}><span className="sw" style={{ border: "1px dashed #94A8BF" }} />Not exposed / not applicable</span>
        <span className="grow" />
        <button className="btn sm" onClick={() => setNotes(!notes)}>{notes ? "Hide notes" : "Show notes"}</button>
        <button className="btn sm" onClick={() => setChecksOpen(true)}>Limit checks…</button>
        <button className="btn sm" onClick={() => setBudgetOpen(true)}>Manual tracking…</button>
      </div>
      <section className="well scroll-x" aria-label="Provider usage" style={{ padding: 6 }}>
        <table className="tbl" style={{ minWidth: 1100 }}>
          <thead>
            <tr>
              <th>Provider</th>
              <th>Account</th>
              <th>Access</th>
              <th style={{ width: "22%" }}>Session / rolling window</th>
              <th style={{ width: "22%" }}>Weekly / monthly</th>
              <th><span data-tip="Reported by each provider's own CLI.">Status</span></th>
            </tr>
          </thead>
          <tbody>
            {clis.map((c) => {
              const h = healths[c.id];
              const local = c.kind === "ollama" || c.kind === "llamacpp";
              const provider = c.kind === "codex" || c.kind === "claude" ? c.kind : null;
              const reported: ProviderLimits | null = provider ? limits?.[provider] ?? null : null;
              const refreshing = provider ? limits?.refreshing[provider] : false;
              const engineLimited = c.kind === orchestratorKind && activeStatus?.limitMessage;
              const budget = budgets.find((b) => b.provider === c.id);
              const used = budget && usage ? usage.records.filter((r) => r.provider === recordProvider(c) && r.timestamp >= monthStart()).reduce((n, r) => n + r.input + r.output, 0) : 0;
              const state = h ? connectionMeta[h.state] : connectionMeta.unchecked;
              const windows = reported?.ok ? reported.windows : [];
              const short = windows.filter((w) => (w.windowMinutes ?? 0) < 1440);
              const long = windows.filter((w) => (w.windowMinutes ?? 0) >= 1440);
              const statusTone = engineLimited || reported?.status === "limited" ? "err" : reported?.status === "warning" ? "warn" : reported?.ok ? "ok" : local ? "mut" : "mut";
              return (
                <tr key={c.id}>
                  <td><div style={{ fontWeight: 600 }}>{providerOf(c)}</div><div className="sub">{c.name}</div></td>
                  <td>
                    <span className="row" style={{ gap: 6 }}>
                      <Dot tone={h?.auth.state === "required" ? "warn" : h?.state === "connected" ? "ok" : state.tone} />
                      {h ? (h.state === "connected" || h.state === "auth-required" ? (h.auth.state === "required" ? "Sign-in required" : h.auth.state === "not-required" ? "Not required" : "Signed in") : state.label) : "Not checked"}
                    </span>
                  </td>
                  <td className="sub" style={{ maxWidth: 200, whiteSpace: "normal" }}>
                    {local ? "Local · no provider quota" : reported?.plan ? <><span style={{ color: "var(--t)" }}>{PLAN_NAMES[reported.plan] ?? reported.plan}</span><br />{h?.auth.detail}</> : h?.auth.detail || "Unknown"}
                  </td>
                  <td>
                    <div className="stack" style={{ gap: 10 }}>
                      {local ? (
                        <Window label="Rolling window" provenance="not-applicable" text="No quota on a local runtime" />
                      ) : short.length ? (
                        short.map((w) => <ReportedWindow key={w.id} w={w} />)
                      ) : engineLimited ? (
                        <Window label="Usage limit" provenance="reported" text="Limit reached" sub={activeStatus?.limitRetryAt ? `retry ${activeStatus.limitRetryAt}` : "waiting for Resume"} />
                      ) : (
                        <Window label="Rolling window" provenance={provider ? "unavailable" : "not-exposed"} text={provider ? (refreshing ? "Checking…" : "Not checked yet") : "Not exposed by the API"} />
                      )}
                    </div>
                  </td>
                  <td>
                    <div className="stack" style={{ gap: 10 }}>
                      {long.map((w) => <ReportedWindow key={w.id} w={w} />)}
                      {budget && <Window label="Monthly budget" provenance="manual" text={`${tokens(used)} of ${tokens(budget.limit)}`} sub="this month" pct={(used / budget.limit) * 100} variant="man" />}
                      {!long.length && !budget && (local ? <Window label="Weekly / monthly" provenance="not-applicable" text="Limited by local hardware only" /> : <Window label="Weekly / monthly" provenance={provider ? "unavailable" : "not-exposed"} text={provider ? (refreshing ? "Checking…" : "Not checked yet") : "Not exposed by the API"} />)}
                    </div>
                  </td>
                  <td style={{ whiteSpace: "normal", maxWidth: 240 }}>
                    <span className="row" style={{ gap: 6 }}>
                      <Dot tone={statusTone} />
                      {engineLimited ? "Usage limit reached" : reported?.ok ? reported.statusText : reported?.error ? "Unavailable" : local ? "n/a" : provider ? "Not checked yet" : "None reported"}
                    </span>
                    {reported?.ok && reported.extras.map((x) => <div key={x.label} className="sub">{x.label}: {x.value}</div>)}
                    {provider && (
                      <div className="row wrap" style={{ gap: 6, marginTop: 6 }}>
                        <button className="btn sm" disabled={refreshing} onClick={() => refresh(provider)} title="Free, read-only">
                          {refreshing ? <Spinner /> : <Icon name="refresh" size="sm" />}
                          Refresh
                        </button>
                        {reported && <span className="sub">as of {ago(reported.fetchedAt)}</span>}
                      </div>
                    )}
                    {reported?.error && <div className="sub err" style={{ marginTop: 4 }}>{reported.error}</div>}
                    {notes && (engineLimited || local || !provider) && (
                      <div className="sub" style={{ marginTop: 4 }}>
                        {engineLimited ? activeStatus?.limitMessage : local ? "Usage is measured as tokens on the Token tab." : "This API does not expose quotas."}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
      <p className="sub" style={{ margin: 0 }}>Percentages and reset times come from each provider's own CLI. Nothing is inferred from plan names.</p>

      {checksOpen && (
        <Modal label="Limit checks" title="Limit checks" onClose={() => setChecksOpen(false)}>
          <label className="field">
            <span>Codex: refresh every</span>
            <select className="sel" value={snap.settings.usage.codexPollMinutes} onChange={(e) => updateSettings((s) => ({ ...s, usage: { ...s.usage, codexPollMinutes: Number(e.target.value) } }))}>
              <option value={0}>Only when I click Refresh</option>
              <option value={1}>1 minute</option>
              <option value={5}>5 minutes</option>
              <option value={15}>15 minutes</option>
              <option value={30}>30 minutes</option>
            </select>
            <span className="hint">Free: checking uses no Codex usage.</span>
          </label>
          <label className="field">
            <span>Claude Code: refresh every</span>
            <select className="sel" value={snap.settings.usage.claudePollMinutes} onChange={(e) => updateSettings((s) => ({ ...s, usage: { ...s.usage, claudePollMinutes: Number(e.target.value) } }))}>
              <option value={0}>Only when I click Refresh</option>
              <option value={1}>1 minute</option>
              <option value={5}>5 minutes</option>
              <option value={15}>15 minutes</option>
              <option value={30}>30 minutes</option>
            </select>
            <span className="hint">Free: checking uses no Claude usage.</span>
          </label>
          <div className="row"><span className="grow" /><button className="btn primary" onClick={() => setChecksOpen(false)}>Done</button></div>
        </Modal>
      )}

      {budgetOpen && (
        <Modal label="Manual tracking" title="Manual usage tracking" onClose={() => setBudgetOpen(false)}>
          <p className="sub" style={{ margin: 0 }}>Set your own monthly token budget for a provider. Usage is counted from the engine's recorded token usage and shown as Manual.</p>
          <div className="grid-f">
            <label className="field"><span>Provider</span>
              <select className="sel" value={draft.provider} onChange={(e) => setDraft({ ...draft, provider: e.target.value })}>
                {clis.filter((c) => c.kind === "codex" || c.kind === "claude" || c.kind === "openai").map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
            <label className="field"><span>Monthly limit (tokens)</span><input className="input" inputMode="numeric" value={draft.limit} onChange={(e) => setDraft({ ...draft, limit: e.target.value.replace(/\D/g, "") })} /></label>
          </div>
          {budgets.length > 0 && (
            <ul className="list">
              {budgets.map((b) => (
                <li key={b.provider}><span className="grow">{b.label}: {tokens(b.limit)} / month</span>
                  <button className="btn ghost sm" onClick={() => updateSettings((s) => ({ ...s, usage: { ...s.usage, manualBudgets: s.usage.manualBudgets.filter((x) => x.provider !== b.provider) } }))}>Remove</button></li>
              ))}
            </ul>
          )}
          <div className="row"><span className="grow" /><button className="btn ghost" onClick={() => setBudgetOpen(false)}>Close</button>
            <button className="btn primary" disabled={!Number(draft.limit)} onClick={async () => {
              const cli = clis.find((c) => c.id === draft.provider)!;
              await updateSettings((s) => ({ ...s, usage: { ...s.usage, manualBudgets: [...s.usage.manualBudgets.filter((x) => x.provider !== cli.id), { provider: cli.id, label: cli.name, limit: Number(draft.limit), unit: "tokens" }] } }));
              toast("success", `Tracking ${cli.name} against a manual monthly budget`);
            }}>Save budget</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
