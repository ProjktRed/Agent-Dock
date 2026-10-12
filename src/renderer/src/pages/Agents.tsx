import { useEffect, useMemo, useState } from "react";
import type { Agent, EngineEvent, Role, TokenRecord } from "@shared/types";
import { cleanError, useApp } from "../store";
import { clock, connectionMeta, roleLabel, tokens, uid } from "../lib/format";
import { agentForRoleClient } from "../lib/agents";
import { Icon } from "../components/Icon";
import { Disclosure, Dot, Empty, Modal, Spinner, St, Support, Tabs, Toggle } from "../components/ui";

const ROLE_EVENTS: Record<string, RegExp> = {
  implementation: /^cline-/,
  qa: /^(codex-qa|qa-)/,
  assessment: /^codex-(assessing|finished)/,
  elevation: /^(sol-reassessment|elevate)/,
};

function eventText(e: EngineEvent) {
  const detail = e.message ?? e.qa ?? (e.model ? `model ${e.model}` : "");
  return `${e.type}${e.attempt != null ? ` #${e.attempt}` : ""}${detail ? ` · ${String(detail).split(/\r?\n/)[0].slice(0, 120)}` : ""}`;
}

function AgentForm({ agent, onSaved, onDelete }: { agent: Agent; onSaved: (a: Agent) => void; onDelete: () => void }) {
  const { snap, healths, toast } = useApp();
  const [draft, setDraft] = useState(agent);
  const [manual, setManual] = useState(false);
  const [testing, setTesting] = useState(false);
  useEffect(() => setDraft(agent), [agent]);
  const orchestrator = draft.role === "qa" || draft.role === "assessment" || draft.role === "elevation";
  const implementation = draft.role === "implementation";
  const cliOptions = snap.clis.filter((c) => (implementation ? c.kind === "cline" : orchestrator ? c.kind === "codex" || c.kind === "claude" : true));
  const cli = snap.clis.find((c) => c.id === draft.cliId);
  const providerCli = implementation ? snap.clis.find((c) => c.kind === draft.provider) : null;
  const discovered = providerCli ? healths[providerCli.id]?.models ?? [] : [];
  const engineModels = cli?.kind === "claude" ? snap.engine.orchestratorModels.claude : snap.engine.orchestratorModels.codex;
  const engineModel = orchestrator ? engineModels[draft.role === "elevation" ? "elevate" : draft.role] : null;
  const modelMax = providerCli ? healths[providerCli.id]?.contextMax : undefined;
  const dirty = JSON.stringify(draft) !== JSON.stringify(agent);
  const set = <K extends keyof Agent>(k: K, v: Agent[K]) => setDraft({ ...draft, [k]: v });

  const test = async () => {
    setTesting(true);
    try {
      const ids = [draft.cliId, providerCli?.id].filter(Boolean) as string[];
      const results = await Promise.all(ids.map((id) => window.api.checkCli(id)));
      const bad = results.find((r) => r.state !== "connected");
      toast(bad ? "error" : "success", bad ? `${snap.clis.find((c) => c.id === bad.id)?.name}: ${connectionMeta[bad.state].label}. ${bad.detail}` : `${results.map((r) => snap.clis.find((c) => c.id === r.id)?.name).join(" and ")} responded`);
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="stack fade-in" style={{ gap: 18 }}>
      <div className="grid-f">
        <label className="field"><span>Display name</span><input className="input" value={draft.name} onChange={(e) => set("name", e.target.value)} /></label>
        <label className="field">
          <span>Workflow role</span>
          <select className="sel" value={draft.role} onChange={(e) => {
            const role = e.target.value as Role;
            const kind = role === "implementation" ? "cline" : role === "custom" ? null : "codex";
            const nextCli = kind ? snap.clis.find((c) => c.kind === kind)?.id ?? draft.cliId : draft.cliId;
            setDraft({ ...draft, role, cliId: nextCli, provider: role === "implementation" ? draft.provider ?? "llamacpp" : undefined });
          }}>
            {(["implementation", "qa", "assessment", "elevation", "custom"] as Role[]).map((r) => <option key={r} value={r}>{roleLabel[r]}</option>)}
          </select>
        </label>
        {draft.role === "custom" && <label className="field"><span>Custom role name</span><input className="input" value={draft.customRole ?? ""} onChange={(e) => set("customRole", e.target.value)} /></label>}
        <label className="field">
          <span>CLI connection</span>
          <select className="sel" value={draft.cliId} onChange={(e) => set("cliId", e.target.value)}>
            {cliOptions.map((c) => <option key={c.id} value={c.id}>{c.name}{healths[c.id] && healths[c.id].state !== "connected" ? ` (${connectionMeta[healths[c.id].state].label})` : ""}</option>)}
          </select>
          {orchestrator && <span className="hint">The engine runs one orchestrator: QA and Assessment must use the same CLI.</span>}
        </label>
        {implementation && (
          <label className="field">
            <span className="row" style={{ gap: 8 }}>Local provider<Support kind="engine" /></span>
            <select className="sel" value={draft.provider} onChange={(e) => setDraft({ ...draft, provider: e.target.value as Agent["provider"], model: e.target.value === "ollama" ? snap.engine.defaults.ollamaModel : snap.engine.defaults.llamacppModel })}>
              <option value="llamacpp">llama.cpp (OpenAI-compatible)</option>
              <option value="ollama">Ollama</option>
            </select>
          </label>
        )}
        <div className="field">
          <span className="row" style={{ gap: 8 }}>Model{orchestrator ? <Support kind="engine" /> : implementation ? <Support kind="engine" /> : <Support kind="saved" />}
            {implementation && discovered.length > 0 && <button className="btn ghost sm" style={{ height: 20, padding: 0, marginLeft: "auto" }} onClick={() => setManual(!manual)}>{manual ? "Choose discovered" : "Enter manually"}</button>}
          </span>
          {orchestrator ? (
            <>
              <input className="input mono" value={engineModel ?? "unknown"} readOnly />
              <span className="hint">Set by the engine for {cli?.kind === "claude" ? "Claude Code" : "Codex CLI"}; the engine does not accept a model override for this role.</span>
            </>
          ) : implementation && discovered.length && !manual ? (
            <>
              <select className="sel" value={draft.model} onChange={(e) => set("model", e.target.value)}>
                {!discovered.some((m) => m.id === draft.model) && <option value={draft.model}>{draft.model} (not advertised)</option>}
                {discovered.map((m) => <option key={m.id} value={m.id}>{m.id}{m.detail ? ` · ${m.detail}` : ""}</option>)}
              </select>
              <span className="hint">{discovered.length} models discovered from {providerCli?.name}</span>
            </>
          ) : (
            <>
              <input className="input mono" value={draft.model} onChange={(e) => set("model", e.target.value)} placeholder="model identifier" />
              <span className="hint">{implementation ? `${providerCli?.name ?? "Provider"} did not list models (is it running?). The engine requires the exact identifier.` : "Manual identifier"}</span>
            </>
          )}
        </div>
        <div className="field">
          <span>Reasoning effort</span>
          {orchestrator ? (
            <>
              <input className="input" value={engineModels.reasoning ?? "—"} readOnly />
              <span className="hint">Fixed by the engine for this orchestrator.</span>
            </>
          ) : (
            <div className="chip dash mut" style={{ height: 36, borderRadius: 11, padding: "0 12px" }}>Not reported as supported for local models</div>
          )}
        </div>
        {implementation && (
          <>
            <label className="field">
              <span className="row" style={{ gap: 8 }}>Maximum context (tokens)<Support kind="engine" /></span>
              <input className="input" inputMode="numeric" value={draft.contextTokens} onChange={(e) => set("contextTokens", Number(e.target.value.replace(/\D/g, "")) || 0)} />
              <span className="hint">{modelMax?.value ? `${modelMax.source}: ${modelMax.value.toLocaleString()}` : "Model maximum not reported"}{modelMax?.value && draft.contextTokens > modelMax.value ? " · exceeds the model maximum" : ""}</span>
            </label>
            <label className="field"><span className="row" style={{ gap: 8 }}>Maximum output tokens<Support kind="engine" /></span><input className="input" inputMode="numeric" value={draft.maxOutputTokens} onChange={(e) => set("maxOutputTokens", Number(e.target.value.replace(/\D/g, "")) || 0)} /></label>
            <label className="field"><span className="row" style={{ gap: 8 }}>Execution timeout (minutes)<Support kind="engine" /></span><input className="input" inputMode="numeric" value={Math.round(draft.timeoutSeconds / 60)} onChange={(e) => set("timeoutSeconds", (Number(e.target.value.replace(/\D/g, "")) || 1) * 60)} /></label>
          </>
        )}
      </div>
      <label className="field">
        <span className="row" style={{ gap: 8 }}>Custom instructions<Support kind="saved" /></span>
        <textarea className="ta" style={{ minHeight: 70 }} value={draft.instructions} onChange={(e) => set("instructions", e.target.value)} placeholder="The engine writes its own role prompts; these notes are stored for when it accepts additions." />
      </label>
      <div className="field">
        <span className="row" style={{ gap: 8 }}>Skills<Support kind="saved" /></span>
        <div className="row wrap" style={{ gap: 10 }}>
          {draft.skills.map((k) => (
            <span className="chip raised" key={k}>{k}<button className="x" onClick={() => set("skills", draft.skills.filter((x) => x !== k))} aria-label={`Remove ${k}`}><Icon name="close" size="sm" /></button></span>
          ))}
          {draft.skills.length === 0 && <span className="sub">None assigned. Manage skills in Settings › Skills.</span>}
        </div>
      </div>
      <div className="well pad stack" style={{ gap: 12 }}>
        <div className="row"><h3 className="h3">Connection health</h3><span className="grow" />{testing && <span className="row sub"><Spinner />Testing…</span>}<button className="btn sm" onClick={test} disabled={testing}>Test connection</button></div>
        <div className="row wrap" style={{ gap: 22, fontSize: 12.5 }}>
          {[cli, providerCli].filter(Boolean).map((c) => {
            const h = healths[c!.id];
            return (
              <span key={c!.id} className="row" style={{ gap: 6 }}>
                <Dot tone={h ? connectionMeta[h.state].tone : "mut"} />
                {c!.name}: {h ? connectionMeta[h.state].label : "Not checked"}
                {h?.latencyMs != null && <span className="sub mono">{h.latencyMs} ms</span>}
              </span>
            );
          })}
        </div>
      </div>
      <div className="row">
        <button className="btn ghost danger" onClick={onDelete}>Delete agent</button>
        <span className="sub grow">{dirty ? "Unsaved changes · they apply when the engine next starts" : "Changes apply when the engine next starts."}</span>
        <button className="btn ghost" disabled={!dirty} onClick={() => setDraft(agent)}>Revert</button>
        <button className="btn primary" disabled={!dirty || !draft.name.trim()} onClick={() => onSaved(draft)}>Save changes</button>
      </div>
    </div>
  );
}

function AgentActivity({ agent }: { agent: Agent }) {
  const { activeStatus: s, activeProject } = useApp();
  const [usage, setUsage] = useState<TokenRecord[]>([]);
  useEffect(() => {
    if (activeProject) void window.api.usage(activeProject.id).then((u) => setUsage(u.records));
  }, [activeProject]);
  if (agent.role === "custom") return <Empty title="Custom roles are not run by the engine yet" icon="agent" />;
  const pattern = ROLE_EVENTS[agent.role];
  const events = (s?.events ?? []).filter((e) => pattern.test(e.type));
  const roleName = roleLabel[agent.role];
  const active = s?.processAlive && s.activeRole === roleName;
  const records = usage.filter((r) => r.role === agent.role);
  const sum = (k: "input" | "output" | "cached") => records.reduce((n, r) => n + r[k], 0);
  const issues = events.filter((e) => /fail|error|limit|blocked/i.test(e.type));
  if (!events.length && !active) return <Empty title="No activity for this role in the active project" icon="agent"><span>{activeProject ? `Project: ${activeProject.name}` : "No active project"}</span></Empty>;
  return (
    <div className="stack fade-in" style={{ gap: 16 }}>
      <dl className="kv two">
        <div><dt>Current operation</dt><dd className={active ? "ok" : "mut"}>{active ? s?.label : "Idle"}</dd></div>
        <div><dt>Model</dt><dd className="mono">{active ? s?.activeModel ?? "—" : "—"}</dd></div>
        <div style={{ gridColumn: "1 / -1" }}><dt>Last event</dt><dd>{events.at(-1) ? `${clock(events.at(-1)!.timestamp)} · ${eventText(events.at(-1)!)}` : "—"}</dd></div>
      </dl>
      <div className="well" style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}>
        {(["input", "output", "cached"] as const).map((k) => (
          <div key={k} style={{ padding: "12px 14px" }}><span className="sub">{k[0].toUpperCase() + k.slice(1)}</span><b style={{ display: "block", fontSize: 16, fontWeight: 600 }}>{records.length ? tokens(sum(k)) : "—"}</b></div>
        ))}
      </div>
      {agent.role === "qa" && s?.latestQa && <Disclosure title="Latest output"><div className="mono log selectable">{s.latestQa}</div></Disclosure>}
      <div>
        <div className="eyebrow" style={{ marginBottom: 6 }}>Recent actions</div>
        <ul className="list">
          {events.slice(-8).reverse().map((e, i) => (
            <li key={i}><St kind={/fail|error|blocked/.test(e.type) ? "blocked" : /started|running|assessing/.test(e.type) ? "active" : "done"} /><span className="grow ellipsis">{eventText(e)}</span><span className="sub mono">{clock(e.timestamp)}</span></li>
          ))}
        </ul>
      </div>
      <div>
        <div className="eyebrow" style={{ marginBottom: 6 }}>Errors and warnings</div>
        {issues.length ? (
          <ul className="list">{issues.slice(-5).map((e, i) => <li key={i}><Dot tone="warn" /><span className="grow ellipsis">{eventText(e)}</span><span className="sub mono">{clock(e.timestamp)}</span></li>)}</ul>
        ) : <div className="sub">None recorded.</div>}
      </div>
    </div>
  );
}

export function AgentsPage() {
  const { snap, setAgents, toast, activeProject, healths, go } = useApp();
  const [selId, setSelId] = useState<string | null>(snap.agents[0]?.id ?? null);
  const [tab, setTab] = useState<"config" | "activity">("config");
  const [deleting, setDeleting] = useState(false);
  const sel = snap.agents.find((a) => a.id === selId) ?? snap.agents[0] ?? null;
  const roleDefaults = useMemo(
    () => (["implementation", "qa", "assessment", "elevation"] as const).map((r) => ({ role: r, agent: agentForRoleClient(r, activeProject, snap.agents) })),
    [activeProject, snap.agents],
  );

  const save = async (agent: Agent) => {
    try {
      setAgents(await window.api.saveAgent(agent));
      toast("success", `${agent.name} saved`);
    } catch (e) {
      toast("error", cleanError(e));
    }
  };
  const addAgent = async (role: Role) => {
    const cli = snap.clis.find((c) => c.kind === (role === "implementation" ? "cline" : "codex"));
    const agent: Agent = {
      id: uid("agent"),
      name: role === "custom" ? "Custom agent" : `New ${roleLabel[role]} agent`,
      role,
      customRole: role === "custom" ? "Documentation" : undefined,
      cliId: cli?.id ?? snap.clis[0].id,
      provider: role === "implementation" ? "llamacpp" : undefined,
      model: role === "implementation" ? snap.engine.defaults.llamacppModel : "",
      contextTokens: role === "implementation" ? snap.engine.defaults.contextTokens : 0,
      maxOutputTokens: snap.engine.defaults.maxOutputTokens,
      timeoutSeconds: snap.engine.defaults.timeoutSeconds,
      instructions: "",
      skills: [],
      enabled: role !== "custom",
    };
    setAgents(await window.api.saveAgent(agent));
    setSelId(agent.id);
    setTab("config");
  };
  const cliOf = (a: Agent) => snap.clis.find((c) => c.id === a.cliId);

  return (
    <>
      <div className="row wrap" style={{ gap: 14 }}>
        <div><h1 className="h1">Agents</h1><div className="sub">An agent is a configured worker: one CLI connection, one provider and model, one workflow role.</div></div>
        <span className="grow" />
        <button className="btn primary" onClick={() => addAgent("implementation")}><Icon name="plus" size="sm" />Add agent</button>
      </div>

      <section className="stack" aria-label="Workflow role defaults" style={{ gap: 10 }}>
        <div className="row"><span className="eyebrow">Role defaults</span><span className="sub">· {activeProject ? `as resolved for ${activeProject.name}` : "used unless a project overrides them"}</span></div>
        <div className="row wrap" style={{ gap: 16, alignItems: "stretch" }}>
          {roleDefaults.map(({ role, agent }) => {
            const h = agent ? healths[agent.cliId] : undefined;
            return (
              <button key={role} className="opt" style={{ flex: 1, minWidth: 180, flexDirection: "column", gap: 4 }} onClick={() => agent && setSelId(agent.id)}>
                <span className="sub">{roleLabel[role]}</span>
                <span className="row" style={{ fontWeight: 600 }}><Dot tone={!agent ? "err" : h ? connectionMeta[h.state].tone : "mut"} />{agent?.name ?? "Not assigned"}</span>
                <span className="hint">{role === "elevation" ? "Optional · automatic or manual" : agent ? cliOf(agent)?.name : "Add an agent for this role"}</span>
              </button>
            );
          })}
          <button className="opt" style={{ flex: 1, minWidth: 160, justifyContent: "center", alignItems: "center", boxShadow: "none", border: "1.5px dashed rgba(148,168,191,.35)", background: "transparent", color: "var(--t2)" }} onClick={() => addAgent("custom")}>
            <Icon name="plus" />Custom role
          </button>
        </div>
      </section>

      {!sel ? (
        <Empty title="No agents yet" icon="agent"><span>Connect a CLI first, then create an agent for each workflow role.</span><button className="btn" onClick={() => go("clis")}>Open CLIs</button></Empty>
      ) : (
        <div className="split">
          <div className="stack" style={{ gap: 14 }}>
            {snap.agents.map((a) => {
              const cli = cliOf(a);
              const h = cli ? healths[cli.id] : undefined;
              return (
                <button key={a.id} className={`item ${sel.id === a.id ? "on" : ""} ${a.enabled ? "" : "off"}`} onClick={() => setSelId(a.id)} aria-pressed={sel.id === a.id}>
                  <div className="row"><span className="name" style={{ fontWeight: 600, fontSize: 14 }}>{a.name}</span><span className="chip">{a.role === "custom" ? a.customRole || "Custom" : roleLabel[a.role]}</span><span className="grow" /><span className={`sub ${a.enabled ? "" : "mut"}`}>{a.enabled ? "" : "Disabled"}</span></div>
                  <div className="row sub" style={{ fontSize: 11.5, gap: 6 }}><span>{cli?.name ?? "No CLI"}</span>{a.provider && <><span>·</span><span>{a.provider === "llamacpp" ? "llama.cpp" : "Ollama"}</span></>}</div>
                  <div className="row" style={{ gap: 8 }}><span className="mono ellipsis">{a.role === "implementation" || a.role === "custom" ? a.model || "—" : (cli?.kind === "claude" ? snap.engine.orchestratorModels.claude : snap.engine.orchestratorModels.codex)[a.role === "elevation" ? "elevate" : a.role] ?? "—"}</span></div>
                  <div className="row sub" style={{ fontSize: 11.5, gap: 12 }}>
                    <span className={`row ${h ? connectionMeta[h.state].tone : "mut"}`} style={{ gap: 5 }}><Dot tone="" />{h ? connectionMeta[h.state].label : "Not checked"}</span>
                    {a.role === "implementation" && <span>ctx {tokens(a.contextTokens)}</span>}
                  </div>
                </button>
              );
            })}
          </div>
          <section className="card pad stack fade-in" style={{ gap: 18 }} key={sel.id} aria-label="Agent detail">
            <div className="row wrap" style={{ gap: 12 }}>
              <div className="grow"><div className="row"><h2 className="h1">{sel.name}</h2><span className="chip">{sel.role === "custom" ? sel.customRole || "Custom" : roleLabel[sel.role]}</span></div><div className="sub">{cliOf(sel)?.name}{sel.provider ? ` · ${sel.provider}` : ""}</div></div>
              <label className="row" style={{ gap: 10 }}><span className="sub">{sel.enabled ? "Enabled" : "Disabled"}</span><Toggle on={sel.enabled} onChange={(v) => save({ ...sel, enabled: v })} label="Agent enabled" /></label>
            </div>
            {sel.role === "custom" && <div className="banner"><Icon name="warn" className="warn" /><span>The current engine runs only Implementation, QA, Assessment and Elevation. Custom-role agents are saved for future engine support and are not launched.</span></div>}
            <Tabs label="Agent sections" small value={tab} onChange={setTab} options={[{ value: "config", label: "Configuration" }, { value: "activity", label: "Activity" }]} />
            {tab === "config" ? <AgentForm agent={sel} onSaved={save} onDelete={() => setDeleting(true)} /> : <AgentActivity agent={sel} />}
          </section>
        </div>
      )}
      {deleting && sel && (
        <Modal label="Delete agent" onClose={() => setDeleting(false)}>
          <h2 className="h2">Delete {sel.name}?</h2>
          <p className="sub" style={{ margin: 0 }}>Projects that override a role with this agent fall back to the global default.</p>
          <div className="row"><span className="grow" /><button className="btn ghost" onClick={() => setDeleting(false)}>Cancel</button>
            <button className="btn danger-fill" onClick={async () => { setAgents(await window.api.deleteAgent(sel.id)); setDeleting(false); setSelId(null); toast("success", "Agent deleted"); }}>Delete</button></div>
        </Modal>
      )}
    </>
  );
}
