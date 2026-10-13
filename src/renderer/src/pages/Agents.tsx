import { useEffect, useMemo, useState } from "react";
import type { Agent, EngineEvent, Role, TokenRecord } from "@shared/types";
import { cleanError, useApp } from "../store";
import { ago, clock, connectionMeta, roleLabel, tokens, uid } from "../lib/format";
import { agentForRoleClient } from "../lib/agents";
import { defaultModelId, effortLabel, useModelCatalog, withModel } from "../lib/models";
import { Icon } from "../components/Icon";
import { Disclosure, Dot, Empty, Modal, Spinner, St, Support, Tabs, Toggle } from "../components/ui";
import { stageLabel } from "./Workflow";
import { describeEvent, isHiddenEvent } from "../lib/events";

const ROLE_EVENTS: Record<string, RegExp> = {
  implementation: /^(cline-|implementation-)/,
  qa: /^(codex-qa|qa-)/,
  assessment: /^codex-(assessing|finished|operation-consumed)/,
  elevation: /^(sol-reassessment|elevate)/,
};

const eventText = (e: EngineEvent) => describeEvent(e);

function AgentForm({ agent, onSaved, onDelete }: { agent: Agent; onSaved: (a: Agent) => void; onDelete: () => void }) {
  const { snap, healths, toast, go } = useApp();
  const [draft, setDraft] = useState(agent);
  const [manual, setManual] = useState(false);
  const [testing, setTesting] = useState(false);
  useEffect(() => setDraft(agent), [agent]);
  const orchestrator = draft.role === "qa" || draft.role === "assessment" || draft.role === "elevation";
  const implementation = draft.role === "implementation";
  const custom = draft.role === "custom";
  const guarded = snap.settings.advanced.engineGuardrails !== false;
  // Implementation: Cline, OpenCode, Codex or Claude Code. Workflow roles and orchestrator roles: Codex or Claude Code.
  const cliOptions = snap.clis.filter((c) => (implementation ? ["cline", "opencode", "codex", "claude"].includes(c.kind) : c.kind === "codex" || c.kind === "claude" || c.id === draft.cliId));
  const cli = snap.clis.find((c) => c.id === draft.cliId);
  const local = (implementation || custom) && cli?.kind === "cline";
  const openCode = implementation && cli?.kind === "opencode";
  const workflowRole = custom ? snap.roles.find((r) => r.id === draft.customRole || r.name.toLowerCase() === (draft.customRole ?? "").trim().toLowerCase()) ?? null : null;
  const providerCli = local
    ? draft.provider === "openai"
      ? snap.clis.find((c) => c.id === draft.providerCliId) ?? snap.clis.find((c) => c.kind === "openai")
      : snap.clis.find((c) => c.kind === (draft.provider ?? "llamacpp"))
    : openCode ? snap.clis.find((c) => c.id === draft.providerCliId) ?? snap.clis.find((c) => c.kind === "openai") : null;
  // Local models: the list collected from the provider (CLIs › Models) wins over the live health check.
  const collected = providerCli?.collected?.models ?? [];
  const discovered: { id: string; detail: string; thinking?: boolean | null }[] = collected.length ? collected : providerCli ? healths[providerCli.id]?.models ?? [] : [];
  const localModel = discovered.find((m) => m.id === draft.model);
  const catalog = useModelCatalog();
  const roleKey = draft.role === "elevation" ? "elevate" : draft.role;
  const kind = cli?.kind === "claude" || cli?.kind === "codex" ? cli.kind : null;
  const cloud = (orchestrator || custom || implementation) && kind !== null;
  const list = cloud && kind ? catalog?.[kind] ?? null : null;
  const current = list?.models.find((m) => m.id === draft.model);
  const refreshing = kind ? catalog?.refreshing[kind] : false;
  const changeCli = (cliId: string) => {
    const next = snap.clis.find((c) => c.id === cliId);
    const nextKind = next?.kind === "claude" || next?.kind === "codex" ? next.kind : null;
    if (implementation && next?.kind === "cline") {
      // Back to a local provider: the cloud model, effort and speed don't apply.
      const provider = draft.provider ?? "llamacpp";
      return setDraft({ ...draft, cliId, provider, ...(kind ? { model: provider === "ollama" ? snap.engine.defaults.ollamaModel : snap.engine.defaults.llamacppModel, reasoning: "none", fast: false } : {}) });
    }
    if (implementation && next?.kind === "opencode") {
      const provider = snap.clis.find((c) => c.kind === "openai");
      return setDraft({ ...draft, cliId, provider: "openai", providerCliId: provider?.id, ...(provider?.defaultModel ? { model: provider.defaultModel } : {}) });
    }
    if (!(orchestrator || custom || implementation) || !nextKind || nextKind === kind) return setDraft({ ...draft, cliId, provider: custom && next?.kind === "cline" ? draft.provider ?? "llamacpp" : draft.provider });
    const nextList = catalog?.[nextKind];
    setDraft(withModel({ ...draft, cliId, provider: undefined, reasoning: "medium", fast: false }, nextList, defaultModelId(nextList, implementation ? undefined : snap.engine.orchestratorModels[nextKind][roleKey])));
  };
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
          <span>Role</span>
          <select className="sel" value={draft.role} onChange={(e) => {
            const role = e.target.value as Role;
            const kind = role === "implementation" ? "cline" : "codex";
            const nextCli = snap.clis.find((c) => c.kind === kind)?.id ?? draft.cliId;
            setDraft({ ...draft, role, cliId: nextCli, provider: role === "implementation" ? draft.provider ?? "llamacpp" : undefined, customRole: role === "custom" ? draft.customRole || snap.roles[0]?.id || "" : draft.customRole });
          }}>
            {(["implementation", "qa", "assessment", "elevation", "custom"] as Role[]).map((r) => <option key={r} value={r}>{roleLabel[r]}</option>)}
          </select>
        </label>
        {draft.role === "custom" && (
          <label className="field">
            <span className="row" style={{ gap: 8 }}>Workflow role<Support kind="engine" /><a style={{ marginLeft: "auto" }} onClick={() => go("workflow")}>Edit roles</a></span>
            <select className="sel" value={workflowRole?.id ?? draft.customRole ?? ""} onChange={(e) => set("customRole", e.target.value)}>
              {!workflowRole && <option value={draft.customRole ?? ""}>{draft.customRole ? `${draft.customRole} (no such role)` : "Choose a role"}</option>}
              {snap.roles.map((r) => <option key={r.id} value={r.id}>{r.name} · {stageLabel(r.stage)}{r.gate ? " · gate" : ""}</option>)}
            </select>
            <span className="hint">{snap.roles.length ? "This agent runs the role. Create and edit roles in the Workflow tab." : "No workflow roles yet: create one in the Workflow tab."}</span>
          </label>
        )}
        <label className="field">
          <span>CLI connection</span>
          <select className="sel" value={draft.cliId} onChange={(e) => changeCli(e.target.value)}>
            {cliOptions.map((c) => <option key={c.id} value={c.id}>{c.name}{healths[c.id] && healths[c.id].state !== "connected" ? ` (${connectionMeta[healths[c.id].state].label})` : ""}</option>)}
          </select>
          {implementation && kind && <span className="hint">{cli?.name} implements in the project folder. While it runs, file changes are limited to each task's paths{kind === "codex" ? " (by a scope hook the engine adds)" : ""}{snap.settings.workflow.toolGuard ? " and the shell to the task's checks (tool guard)" : ""}. It never commits; scope checks and QA still apply.</span>}
          {orchestrator && <span className="hint">{guarded ? "The engine runs one orchestrator: QA, Assessment and Elevation use the same CLI. Turn off engine guardrails (Settings › Advanced) to mix." : "Engine guardrails are off: this role may use its own CLI."}</span>}
        </label>
        {(local || openCode) && (
          <label className="field">
            <span className="row" style={{ gap: 8 }}>{openCode ? "Provider connection" : "Local provider"}<Support kind="engine" /></span>
            {local ? (
              <select className="sel" value={draft.provider === "openai" ? `connection:${providerCli?.id ?? ""}` : draft.provider ?? "llamacpp"} onChange={(e) => {
                const selected = e.target.value;
                const remote = selected.startsWith("connection:") ? snap.clis.find((c) => c.id === selected.slice("connection:".length)) : undefined;
                const provider = selected === "ollama" ? "ollama" : "llamacpp";
                setDraft({ ...draft, provider: remote ? "openai" : provider, providerCliId: remote?.id, model: remote?.defaultModel ?? (provider === "ollama" ? snap.engine.defaults.ollamaModel : snap.engine.defaults.llamacppModel) });
              }}>
                <option value="llamacpp">llama.cpp (OpenAI-compatible)</option>
                <option value="ollama">Ollama</option>
                {implementation && snap.clis.filter((c) => c.kind === "openai").map((c) => <option key={c.id} value={`connection:${c.id}`}>{c.name} (OpenAI-compatible){c.hasSecret ? " · key saved" : " · no key"}</option>)}
              </select>
            ) : (
              <select className="sel" value={providerCli?.id ?? ""} onChange={(e) => setDraft({ ...draft, provider: "openai", providerCliId: e.target.value, model: snap.clis.find((c) => c.id === e.target.value)?.defaultModel ?? draft.model })}>
                {snap.clis.filter((c) => c.kind === "openai").map((c) => <option key={c.id} value={c.id}>{c.name}{c.hasSecret ? " · key saved" : " · no key"}</option>)}
              </select>
            )}
            {openCode && !providerCli && <span className="hint">Add an OpenAI-compatible provider in CLIs first.</span>}
          </label>
        )}
        <div className="field">
          <span className="row" style={{ gap: 8 }}>Model<Support kind="engine" />
            {local && discovered.length > 0 && <button className="btn ghost sm" style={{ height: 20, padding: 0, marginLeft: "auto" }} onClick={() => setManual(!manual)}>{manual ? "Choose discovered" : "Enter manually"}</button>}
            {cloud && kind && (
              <span className="row" style={{ gap: 6, marginLeft: "auto" }}>
                {list?.ok && <button className="btn ghost sm" style={{ height: 20, padding: 0 }} onClick={() => setManual(!manual)}>{manual ? "Choose from list" : "Enter manually"}</button>}
                <button className="btn ghost sm icon" style={{ height: 20, width: 20 }} disabled={refreshing} onClick={() => window.api.refreshModels(kind).catch((e) => toast("error", cleanError(e)))} aria-label="Refresh model list" title="Ask the CLI for its model list again">
                  {refreshing ? <Spinner /> : <Icon name="refresh" size="sm" />}
                </button>
              </span>
            )}
          </span>
          {cloud ? (
            list?.ok && list.models.length && !manual ? (
              <>
                <select className="sel" value={draft.model} onChange={(e) => setDraft(withModel(draft, list, e.target.value))}>
                  {!current && <option value={draft.model}>{draft.model || "Engine default"} (not listed by {cli?.name})</option>}
                  {list.models.map((m) => (
                    <option key={m.id} value={m.id}>{m.displayName}{m.isDefault ? " (CLI default)" : ""}{m.description ? ` · ${m.description}` : ""}</option>
                  ))}
                </select>
                <span className="hint">
                  <span className="mono">{current?.resolved ?? draft.model}</span> · {list.models.length} models reported by {cli?.name} {ago(list.fetchedAt)}
                  {list.error ? ` · ${list.error}` : ""}
                </span>
              </>
            ) : (
              <>
                <input className="input mono" value={draft.model} onChange={(e) => set("model", e.target.value.trim())} placeholder={snap.engine.orchestratorModels[kind ?? "codex"][roleKey] ?? "model identifier"} />
                <span className="hint">
                  {refreshing ? `Asking ${cli?.name} for its models…` : list?.error ? `${cli?.name} did not list models: ${list.error}` : manual ? "Exact model identifier or alias, passed to the CLI as given." : `No model list from ${cli?.name ?? "this CLI"} yet. Use the refresh button.`}
                </span>
              </>
            )
          ) : local && discovered.length && !manual ? (
            <>
              <select className="sel" value={draft.model} onChange={(e) => set("model", e.target.value)}>
                {!localModel && <option value={draft.model}>{draft.model} (not listed by {providerCli?.name})</option>}
                {discovered.map((m) => <option key={m.id} value={m.id}>{m.id}{m.detail ? ` · ${m.detail}` : ""}</option>)}
              </select>
              <span className="hint">
                {collected.length ? `${collected.length} models collected from ${providerCli?.name} ${ago(providerCli?.collected?.at)}` : `${discovered.length} models discovered from the running ${providerCli?.name}`} ·{" "}
                <a onClick={() => go("clis")}>refresh in CLIs › Models</a>
              </span>
            </>
          ) : (
            <>
              <input className="input mono" value={draft.model} onChange={(e) => set("model", e.target.value)} placeholder="model identifier" />
              <span className="hint">
                {local ? (
                  <>
                    No model list from {providerCli?.name ?? "the provider"} yet. <a onClick={() => go("clis")}>Collect it in CLIs › Models</a>, or type the exact identifier.
                  </>
                ) : (
                  "Manual identifier"
                )}
              </span>
            </>
          )}
        </div>
        <div className="field">
          <span className="row" style={{ gap: 8 }}>{local ? "Thinking" : "Reasoning effort"}<Support kind="engine" /></span>
          {cloud ? (
            current && current.efforts.length === 0 ? (
              <div className="chip dash mut" style={{ height: 36, borderRadius: 11, padding: "0 12px" }}>{current.displayName} has no effort setting</div>
            ) : (
              <>
                <select className="sel" value={draft.reasoning ?? "medium"} onChange={(e) => set("reasoning", e.target.value)}>
                  {(current?.efforts.length ? current.efforts : ["low", "medium", "high", "xhigh", "max"]).map((effort) => (
                    <option key={effort} value={effort}>{effortLabel(effort)}{current?.defaultEffort === effort ? " (model default)" : ""}</option>
                  ))}
                </select>
                <span className="hint">{current ? `Levels ${current.displayName} supports, as reported by ${cli?.name}` : "Model not in the CLI's list: common levels shown"}</span>
              </>
            )
          ) : local ? (
            <>
              <select className="sel" value={draft.reasoning ?? "none"} onChange={(e) => set("reasoning", e.target.value)}>
                {["none", "low", "medium", "high", "xhigh"].map((level) => (
                  <option key={level} value={level}>{level === "none" ? "Off" : effortLabel(level)}</option>
                ))}
              </select>
              <span className="hint">
                {localModel?.thinking === true
                  ? `${providerCli?.name} reports that ${draft.model} can think. `
                  : localModel?.thinking === false
                    ? `${providerCli?.name} reports no thinking support for ${draft.model}; Cline's level is ignored. `
                    : ""}
                Sent as Cline --thinking.{draft.provider === "llamacpp" ? " llama.cpp is started with reasoning on (and this effort) when it isn't Off; a server that is already running keeps its setting." : ""}
              </span>
            </>
          ) : (
            <div className="chip dash mut" style={{ height: 36, borderRadius: 11, padding: "0 12px" }}>Not used by this role</div>
          )}
        </div>
        {local && (
          <div className="field">
            <span>Speed</span>
            <div className="chip dash mut" style={{ height: 36, borderRadius: 11, padding: "0 12px" }} title="Local speed comes from your hardware and llama.cpp / Ollama server settings">Not applicable for local models</div>
          </div>
        )}
        {cloud && (
          <div className="field">
            <span className="row" style={{ gap: 8 }}>Speed<Support kind="engine" /></span>
            <Tabs
              label="Speed"
              value={draft.fast ? "fast" : "standard"}
              onChange={(v) => set("fast", v === "fast")}
              options={[
                { value: "standard", label: "Standard" },
                // Guardrails off: Fast can be chosen even when the model or account doesn't report it.
                { value: "fast", label: "Fast", disabled: guarded && (!current?.fast || (Boolean(list?.fastBlockedReason) && !draft.fast)) },
              ]}
            />
            <span className="hint">
              {!current
                ? "Speed tiers are listed per model; pick a listed model to see them."
                : !current.fast
                  ? `${current.displayName} has no Fast tier`
                  : list?.fastBlockedReason
                    ? `Fast unavailable: ${list.fastBlockedReason}`
                    : `Fast: ${current.fastDescription ?? "faster output"}`}
              {!guarded && (!current?.fast || list?.fastBlockedReason) ? " · Guardrails off: Fast is sent anyway." : ""}
            </span>
          </div>
        )}
        {implementation && (
          <>
            {local && <label className="field">
              <span className="row" style={{ gap: 8 }}>Maximum context (tokens)<Support kind="engine" /></span>
              <input className="input" inputMode="numeric" value={draft.contextTokens} onChange={(e) => set("contextTokens", Number(e.target.value.replace(/\D/g, "")) || 0)} />
              <span className="hint">{modelMax?.value ? `${modelMax.source}: ${modelMax.value.toLocaleString()}` : "Model maximum not reported"}{modelMax?.value && draft.contextTokens > modelMax.value ? " · exceeds the model maximum" : ""}</span>
            </label>}
            {local && <label className="field"><span className="row" style={{ gap: 8 }}>Maximum output tokens<Support kind="engine" /></span><input className="input" inputMode="numeric" value={draft.maxOutputTokens} onChange={(e) => set("maxOutputTokens", Number(e.target.value.replace(/\D/g, "")) || 0)} /></label>}
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
  const { activeStatus: s, activeProject, snap } = useApp();
  const [usage, setUsage] = useState<TokenRecord[]>([]);
  useEffect(() => {
    if (activeProject) void window.api.usage(activeProject.id).then((u) => setUsage(u.records));
  }, [activeProject]);
  // A workflow role agent: its own role's events (role-started / role-result / role-error carry roleName).
  const workflowRole = agent.role === "custom" ? snap.roles.find((r) => r.id === agent.customRole) ?? null : null;
  const pattern = ROLE_EVENTS[agent.role] ?? /^role-/;
  const events = (s?.events ?? []).filter((e) => !isHiddenEvent(e) && pattern.test(e.type) && (!workflowRole || e.roleName === workflowRole.name));
  const roleName = workflowRole ? workflowRole.name : roleLabel[agent.role];
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
      name: role === "custom" ? "Workflow role agent" : `New ${roleLabel[role]} agent`,
      role,
      customRole: role === "custom" ? snap.roles[0]?.id ?? "" : undefined,
      cliId: cli?.id ?? snap.clis[0].id,
      provider: role === "implementation" ? "llamacpp" : undefined,
      model: role === "implementation" ? snap.engine.defaults.llamacppModel : "",
      contextTokens: role === "implementation" ? snap.settings.tuning.defaultContextTokens ?? snap.engine.defaults.contextTokens : 0,
      maxOutputTokens: snap.settings.tuning.defaultMaxOutputTokens ?? snap.engine.defaults.maxOutputTokens,
      timeoutSeconds: snap.engine.defaults.timeoutSeconds,
      instructions: "",
      skills: [],
      enabled: role !== "custom" || snap.roles.length > 0,
    };
    setAgents(await window.api.saveAgent(agent));
    setSelId(agent.id);
    setTab("config");
  };
  const cliOf = (a: Agent) => snap.clis.find((c) => c.id === a.cliId);
  const roleName = (a: Agent) => snap.roles.find((r) => r.id === a.customRole)?.name ?? (a.customRole || "Workflow role");
  const selRole = sel?.role === "custom" ? snap.roles.find((r) => r.id === sel.customRole || r.name.toLowerCase() === (sel.customRole ?? "").toLowerCase()) : null;

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
            <Icon name="plus" />Workflow role agent
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
                  <div className="row"><span className="name" style={{ fontWeight: 600, fontSize: 14 }}>{a.name}</span><span className="chip">{a.role === "custom" ? roleName(a) : roleLabel[a.role]}</span><span className="grow" /><span className={`sub ${a.enabled ? "" : "mut"}`}>{a.enabled ? "" : "Disabled"}</span></div>
                  <div className="row sub" style={{ fontSize: 11.5, gap: 6 }}><span>{cli?.name ?? "No CLI"}</span>{a.provider && <><span>·</span><span>{a.provider === "llamacpp" ? "llama.cpp" : a.provider === "ollama" ? "Ollama" : snap.clis.find((c) => c.id === a.providerCliId)?.name ?? "OpenAI-compatible"}</span></>}</div>
                  <div className="row" style={{ gap: 8 }}><span className="mono ellipsis">{a.model || "—"}</span>{a.reasoning && a.role !== "implementation" && <span className="sub">{effortLabel(a.reasoning)}</span>}{a.fast && <span className="chip">Fast</span>}</div>
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
              <div className="grow"><div className="row"><h2 className="h1">{sel.name}</h2><span className="chip">{sel.role === "custom" ? roleName(sel) : roleLabel[sel.role]}</span></div><div className="sub">{cliOf(sel)?.name}{sel.provider ? ` · ${sel.provider}` : ""}</div></div>
              <label className="row" style={{ gap: 10 }}><span className="sub">{sel.enabled ? "Enabled" : "Disabled"}</span><Toggle on={sel.enabled} onChange={(v) => save({ ...sel, enabled: v })} label="Agent enabled" /></label>
            </div>
            {sel.role === "custom" && (selRole
              ? <div className="banner"><Icon name="workflow" className="info" /><span>Runs the workflow role <b>{selRole.name}</b> ({stageLabel(selRole.stage).toLowerCase()}{selRole.gate ? ", gate" : ""}){selRole.enabled ? "" : ", which is disabled"}. <a onClick={() => go("workflow")}>Open in Workflow</a></span></div>
              : <div className="banner warnb"><Icon name="warn" className="warn" /><span>Not linked to a workflow role, so the engine doesn't run it. Pick a role below or create one in <a onClick={() => go("workflow")}>Workflow</a>.</span></div>)}
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
