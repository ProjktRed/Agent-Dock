import { useState } from "react";
import type { CliConnection } from "@shared/types";
import { cleanError, useApp } from "../../store";
import { clock, connectionMeta } from "../../lib/format";
import { Icon } from "../../components/Icon";
import { Dot, Empty, Modal, ProvenanceChip, Spinner, St, Tabs } from "../../components/ui";
import { AddCliDialog } from "./AddCliDialog";
import { effortLabel, useModelCatalog } from "../../lib/models";

type DetailTab = "connection" | "models" | "caps" | "env" | "logs";

function ConnectionForm({ cli }: { cli: CliConnection }) {
  const { setClis, toast, healths } = useApp();
  const [draft, setDraft] = useState(cli);
  const [secret, setSecret] = useState<string | null>(null);
  const h = healths[cli.id];
  const exe = ["codex", "claude", "cline"].includes(cli.kind);
  const dirty = JSON.stringify(draft) !== JSON.stringify(cli) || secret !== null;
  const save = async () => {
    try {
      setClis(await window.api.saveCli(draft, secret === null ? undefined : secret));
      setSecret(null);
      toast("success", `${draft.name} saved`);
      void window.api.checkCli(cli.id);
    } catch (e) {
      toast("error", cleanError(e));
    }
  };
  return (
    <div className="stack fade-in" style={{ gap: 16 }}>
      <label className="field">
        <span>{exe ? "Executable path or command" : "Endpoint"}</span>
        <input className="input mono" value={draft.location} onChange={(e) => setDraft({ ...draft, location: e.target.value })} />
        <span className="hint">{exe ? (h?.resolvedPath ? `Resolved to ${h.resolvedPath}` : "Resolved through the Windows PATH") : "Base URL used for every request"}</span>
      </label>
      <div className="grid-f">
        <div className="field"><span>Authentication</span><div className="row" style={{ minHeight: 36 }}><Dot tone={h?.auth.state === "ok" || h?.auth.state === "not-required" ? "ok" : h?.auth.state === "required" ? "warn" : "mut"} /><span className="ellipsis" title={h?.auth.detail}>{h?.auth.detail ?? "Not checked"}</span></div></div>
        {cli.kind === "openai" ? (
          <label className="field"><span>API key</span>
            <input className="input mono" type="password" autoComplete="off" value={secret ?? ""} placeholder={cli.hasSecret ? "•••••••• stored · type to replace" : "Not set"} onChange={(e) => setSecret(e.target.value)} />
            <span className="hint">Encrypted with Windows DPAPI. Never displayed.</span>
          </label>
        ) : (
          <div className="field"><span>Stored credential</span><div className="row" style={{ minHeight: 36 }} ><span className="sub">{exe ? "Managed by the CLI itself" : "None required"}</span></div></div>
        )}
        <label className="field"><span>Startup timeout (s)</span><input className="input" inputMode="numeric" value={draft.startupTimeoutSeconds} onChange={(e) => setDraft({ ...draft, startupTimeoutSeconds: Number(e.target.value) || 1 })} /></label>
        <label className="field"><span>Request timeout (s)</span><input className="input" inputMode="numeric" value={draft.requestTimeoutSeconds} onChange={(e) => setDraft({ ...draft, requestTimeoutSeconds: Number(e.target.value) || 1 })} /></label>
      </div>
      <div className="well pad stack" style={{ gap: 10 }}>
        <h3 className="h3">Context limits</h3>
        <div className="row wrap" style={{ gap: 24 }}>
          <div><div className="sub">Provider-defined</div><div className="row">{h?.contextMax.value ? h.contextMax.value.toLocaleString() : "Unknown"}{h && <ProvenanceChip value={h.contextMax.provenance} />}</div><div className="hint">{h?.contextMax.source}</div></div>
          <div className="sub" style={{ maxWidth: 280 }}>Your limit is set per agent (Agents › Maximum context), because the engine applies it per worker.</div>
        </div>
      </div>
      <div className="row"><span className="sub grow">{dirty ? "Unsaved changes" : ""}</span><button className="btn ghost" disabled={!dirty} onClick={() => { setDraft(cli); setSecret(null); }}>Revert</button><button className="btn primary" disabled={!dirty} onClick={save}>Save</button></div>
    </div>
  );
}

/** Codex CLI / Claude Code: the models the CLI itself reports (model/list, initialize). */
function CloudModels({ kind, name }: { kind: "codex" | "claude"; name: string }) {
  const { toast } = useApp();
  const catalog = useModelCatalog();
  const list = catalog?.[kind];
  const busy = catalog?.refreshing[kind];
  return (
    <div className="stack fade-in" style={{ gap: 12 }}>
      <div className="row" style={{ gap: 10 }}>
        <span className="sub grow">{list ? `${list.models.length} models · ${list.source} · ${clock(list.fetchedAt)}` : `No list from ${name} yet`}</span>
        <button className="btn sm" disabled={busy} onClick={() => window.api.refreshModels(kind).catch((e) => toast("error", cleanError(e)))}>{busy ? <Spinner /> : <Icon name="refresh" size="sm" />}Refresh</button>
      </div>
      {list?.error && <div className="banner"><Icon name="warn" className="warn" /><span>{list.error}</span></div>}
      {list?.fastBlockedReason && <div className="banner"><Icon name="warn" className="warn" /><span>Fast: {list.fastBlockedReason}</span></div>}
      <div className="well" style={{ padding: 6 }}>
        {list?.models.length ? (
          <ul className="list">
            {list.models.map((m) => (
              <li key={m.id} style={{ padding: "4px 8px", alignItems: "flex-start" }}>
                <div className="grow stack" style={{ gap: 2 }}>
                  <span className="row" style={{ gap: 8 }}>
                    <b style={{ fontWeight: 600 }}>{m.displayName}</b>
                    <span className="mono mut" style={{ fontSize: 11.5 }}>{m.resolved ?? m.id}</span>
                    {m.isDefault && <span className="chip info" style={{ height: 18, fontSize: 10.5 }}>CLI default</span>}
                    {m.fast && <span className="chip" style={{ height: 18, fontSize: 10.5 }} title={m.fastDescription ?? ""}>Fast</span>}
                  </span>
                  <span className="sub">{m.description}{m.efforts.length ? ` · effort ${m.efforts.map(effortLabel).join(", ")}` : " · no effort setting"}</span>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <div className="empty">{busy ? `Asking ${name}…` : `Press Refresh to ask ${name} for its models.`}</div>
        )}
      </div>
      <span className="hint">Pick a model, effort and speed per agent in Agents. Reading the list is free: no prompt is sent.</span>
    </div>
  );
}

/** Local providers: the model list collected from the provider itself, refreshed on demand. */
export function LocalModels({ cli }: { cli: CliConnection }) {
  const { setClis, toast } = useApp();
  const [busy, setBusy] = useState(false);
  const [dir, setDir] = useState(cli.modelsDir ?? "");
  const collected = cli.collected;
  const collect = async () => {
    setBusy(true);
    try {
      const clis = await window.api.collectModels(cli.id);
      setClis(clis);
      const next = clis.find((c) => c.id === cli.id)?.collected;
      if (next?.error) toast("warning", next.error);
      else toast("success", `${next?.models.length ?? 0} models from ${cli.name}`);
    } catch (e) {
      toast("error", cleanError(e));
    } finally {
      setBusy(false);
    }
  };
  const saveDir = async (value: string | null) => {
    setClis(await window.api.saveCli({ ...cli, modelsDir: value }));
    setDir(value ?? "");
  };
  return (
    <div className="stack fade-in" style={{ gap: 12 }}>
      {cli.kind === "llamacpp" && (
        <div className="well pad stack" style={{ gap: 8 }}>
          <div className="row" style={{ gap: 8 }}><b style={{ fontWeight: 600 }} className="grow">Models folder (router mode)</b>{cli.modelsDir ? <span className="chip info">On</span> : <span className="chip">Off · launcher's single model</span>}</div>
          <div className="row" style={{ gap: 8 }}>
            <input className="input mono grow" value={dir} placeholder="D:\models" onChange={(e) => setDir(e.target.value)} aria-label="Models folder" />
            <button className="btn sm" onClick={async () => { const found = await window.api.detectModelsDir(); if (found) setDir(found); else toast("warning", "No models folder found in the launcher settings"); }}>Detect</button>
            <button className="btn sm" disabled={dir.trim() === (cli.modelsDir ?? "")} onClick={() => void saveDir(dir.trim() || null)}>Save</button>
            {cli.modelsDir && <button className="btn ghost sm" onClick={() => void saveDir(null)}>Turn off</button>}
          </div>
          <span className="hint">With a folder set, the engine starts llama.cpp with --models-dir: the server lists every model in the folder and loads the one the Implementation agent uses. Each subfolder counts as one model. Applies when the engine next starts the server.</span>
        </div>
      )}
      <div className="row" style={{ gap: 10 }}>
        <span className="sub grow">
          {collected ? `${collected.models.length} models · ${collected.source} · ${clock(collected.at)}` : `No list collected from ${cli.name} yet`}
        </span>
        <button className="btn sm" disabled={busy} onClick={() => void collect()}>{busy ? <Spinner /> : <Icon name="refresh" size="sm" />}Refresh</button>
      </div>
      {collected?.error && <div className="banner"><Icon name="warn" className="warn" /><span>{collected.error}</span></div>}
      <div className="well" style={{ padding: 6 }}>
        {collected?.models.length ? (
          collected.models.map((m) => (
            <button key={m.id} className={`radio ${cli.defaultModel === m.id ? "on" : ""}`} role="radio" aria-checked={cli.defaultModel === m.id} onClick={async () => setClis(await window.api.saveCli({ ...cli, defaultModel: m.id }))}>
              <span className="rd" /><span className="mono grow">{m.id}</span>
              {m.thinking && <span className="chip">Thinking</span>}
              <span className="sub">{m.detail}</span>
              {cli.defaultModel === m.id && <span className="chip info" style={{ height: 18, fontSize: 10.5 }}>Default</span>}
            </button>
          ))
        ) : (
          <div className="empty">{busy ? `Asking ${cli.name}…` : `Press Refresh to ask ${cli.name} for its models.`}</div>
        )}
      </div>
    </div>
  );
}

export function ClisPage() {
  const { snap, healths, setClis, toast, statuses } = useApp();
  const [selId, setSelId] = useState(snap.clis.find((c) => healths[c.id] && healths[c.id].state !== "connected")?.id ?? snap.clis[0]?.id);
  const [tab, setTab] = useState<DetailTab>("connection");
  const catalog = useModelCatalog();
  const modelCount = (c: CliConnection) => {
    const n = c.kind === "codex" || c.kind === "claude" ? catalog?.[c.kind]?.models.length : c.collected?.models.length;
    return n ? `${n} models` : null;
  };
  const [adding, setAdding] = useState(false);
  const [checking, setChecking] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const sel = snap.clis.find((c) => c.id === selId) ?? snap.clis[0];
  const h = sel ? healths[sel.id] : undefined;
  const list = Object.values(healths);
  const healthy = list.filter((x) => x.state === "connected").length;
  const limited = Object.values(statuses).find((s) => s.limitMessage);

  const check = async (id: string) => {
    setChecking(id);
    try {
      const r = await window.api.checkCli(id);
      const c = snap.clis.find((x) => x.id === id)!;
      toast(r.state === "connected" ? "success" : "error", `${c.name}: ${connectionMeta[r.state].label}${r.state === "connected" ? "" : ` · ${r.detail}`}`);
    } finally {
      setChecking(null);
    }
  };
  const checkAll = async () => {
    setChecking("all");
    await Promise.all(snap.clis.map((c) => window.api.checkCli(c.id)));
    setChecking(null);
  };

  return (
    <>
      <div className="row wrap" style={{ gap: 14 }}>
        <div><h1 className="h1">CLIs and runtimes</h1><div className="sub">Tool connections that agents run through. {healthy} healthy · {list.length - healthy} need attention</div></div>
        <span className="grow" />
        <button className="btn" onClick={checkAll} disabled={checking !== null}>{checking === "all" ? <Spinner /> : <Icon name="refresh" size="sm" />}Check all</button>
        <button className="btn primary" onClick={() => setAdding(true)}><Icon name="plus" size="sm" />Add CLI / runtime</button>
      </div>
      {limited && <div className="banner warnb"><Icon name="warn" className="warn" /><span>The orchestrator reported a usage limit: {limited.limitMessage}</span></div>}

      {!sel ? (
        <Empty title="No CLIs connected" icon="terminal"><button className="btn primary" onClick={() => setAdding(true)}>Add CLI / runtime</button></Empty>
      ) : (
        <div className="split wide-right">
          <section className="well scroll-x" aria-label="Registered connections" style={{ padding: 6 }}>
            <table className="tbl" style={{ minWidth: 560 }}>
              <thead><tr><th>Connection</th><th>Status</th><th>Version</th><th>Models</th></tr></thead>
              <tbody>
                {snap.clis.map((c) => {
                  const hh = healths[c.id];
                  const meta = hh ? connectionMeta[hh.state] : connectionMeta.checking;
                  return (
                    <tr key={c.id} className={`click ${c.id === sel.id ? "sel" : ""}`} onClick={() => setSelId(c.id)}>
                      <td><button className="rowbtn" aria-pressed={c.id === sel.id}><span className="name" style={{ fontWeight: 600 }}>{c.name}</span><span className="mono mut ellipsis" style={{ fontSize: 11, maxWidth: 260 }}>{hh?.resolvedPath ?? c.location}</span></button></td>
                      <td><span className={`row ${meta.tone}`} style={{ gap: 6 }}><Dot tone="" live={!hh} />{meta.label}</span>{hh && hh.state === "connected" && hh.auth.state === "required" && <span className="sub">Sign-in required</span>}</td>
                      <td className="mono">{hh?.version ?? "—"}</td>
                      <td className="sub">{modelCount(c) ?? (hh?.models.length ? `${hh.models.length} discovered` : "—")}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>

          <section className="card pad stack fade-in" style={{ gap: 18 }} key={sel.id} aria-label="Connection detail">
            <div className="row wrap" style={{ gap: 10 }}>
              <div className="grow">
                <h2 className="h1">{sel.name}</h2>
                <div className="row sub" style={{ gap: 6 }}><span>{sel.kind}</span><span>·</span><span className={`row ${h ? connectionMeta[h.state].tone : "mut"}`} style={{ gap: 5 }}><Dot tone="" />{h ? connectionMeta[h.state].label : "Checking…"}</span>{h?.checkedAt && <span>· checked {clock(h.checkedAt)}</span>}</div>
              </div>
              <button className="btn sm" onClick={() => check(sel.id)} disabled={checking !== null}>{checking === sel.id && <Spinner />}Test</button>
              {!sel.builtIn && <button className="btn sm danger" onClick={() => setRemoving(true)}>Remove…</button>}
            </div>
            {h && h.state !== "connected" && (
              <div className="banner errb" role="alert"><Icon name="warn" className="err" /><div className="grow"><div style={{ fontWeight: 600 }}>{connectionMeta[h.state].label}</div><div className="sub">{h.detail}</div></div></div>
            )}
            <Tabs<DetailTab> label="Connection sections" small value={tab} onChange={setTab} options={[
              { value: "connection", label: "Connection" },
              { value: "models", label: "Models" },
              { value: "caps", label: "Capabilities" },
              { value: "env", label: "Environment" },
              { value: "logs", label: "Logs" },
            ]} />
            {tab === "connection" && <ConnectionForm cli={sel} key={sel.id + JSON.stringify(sel)} />}
            {tab === "models" && (sel.kind === "llamacpp" || sel.kind === "ollama") && <LocalModels key={sel.id} cli={sel} />}
            {tab === "models" && (sel.kind === "codex" || sel.kind === "claude") && <CloudModels kind={sel.kind} name={sel.name} />}
            {tab === "models" && sel.kind === "cline" && (
              <div className="well pad sub fade-in">Cline runs the model set on the agent that uses it, served by llama.cpp or Ollama. Their Models tabs list what is available.</div>
            )}
            {tab === "models" && !["llamacpp", "ollama", "codex", "claude", "cline"].includes(sel.kind) && (
              <div className="stack fade-in" style={{ gap: 12 }}>
                <div className="row"><span className="sub grow">{h?.models.length ? `${h.models.length} models discovered` : "No models discovered"}</span><button className="btn sm" onClick={() => check(sel.id)}>Refresh</button></div>
                <div className="well" style={{ padding: 6 }}>
                  {h?.models.length ? (
                    h.models.map((m) => (
                      <button key={m.id} className={`radio ${sel.defaultModel === m.id ? "on" : ""}`} role="radio" aria-checked={sel.defaultModel === m.id} onClick={async () => setClis(await window.api.saveCli({ ...sel, defaultModel: m.id }))}>
                        <span className="rd" /><span className="mono grow">{m.id}</span><span className="sub">{m.detail}</span>
                        {sel.defaultModel === m.id && <span className="chip info" style={{ height: 18, fontSize: 10.5 }}>Default</span>}
                      </button>
                    ))
                  ) : (
                    <div className="empty">{["codex", "claude", "cline"].includes(sel.kind) ? "This CLI does not list models. The engine chooses the orchestrator model; Cline uses the model set on the Implementation agent." : "The runtime did not list models. Is it running?"}</div>
                  )}
                </div>
              </div>
            )}
            {tab === "caps" && (
              <div className="well pad fade-in">
                <ul className="list">
                  {(h?.capabilities ?? []).map((c) => <li key={c.name}><St kind={c.state === "detected" ? "done" : c.state === "partial" ? "part" : c.state === "unsupported" ? "blocked" : "pending"} title={c.state} /><span className="grow">{c.name}</span><span className="sub">{c.detail}</span></li>)}
                  {!h?.capabilities.length && <li className="sub">Capabilities are detected when the connection responds.</li>}
                </ul>
                <div className="row sub wrap" style={{ gap: 14, fontSize: 11.5, marginTop: 10 }}>
                  <span className="row" style={{ gap: 6 }}><St kind="done" />Detected</span><span className="row" style={{ gap: 6 }}><St kind="part" />Partial</span><span className="row" style={{ gap: 6 }}><St kind="blocked" />Unsupported</span><span className="row" style={{ gap: 6 }}><St kind="pending" />Unknown</span>
                </div>
              </div>
            )}
            {tab === "env" && (
              <div className="stack fade-in" style={{ gap: 12 }}>
                <div className="well pad stack" style={{ gap: 8 }}>
                  <div className="sub">The engine launches CLIs with the app's environment. For Claude Code it strips every CLAUDE* variable so children never attach to an interactive session, and Cline gets an isolated config and data directory inside the project's engine state folder.</div>
                  <div className="sub">Secrets are referenced from Windows Credential storage, never written to config files.</div>
                </div>
              </div>
            )}
            {tab === "logs" && (
              <div className="stack fade-in" style={{ gap: 10 }}>
                <div className="row"><span className="sub grow">Last health check</span></div>
                <div className="mono log selectable">{h?.log.join("\n") || "No log yet."}</div>
              </div>
            )}
          </section>
        </div>
      )}
      {adding && <AddCliDialog onClose={() => setAdding(false)} />}
      {removing && sel && (
        <Modal label="Remove connection" onClose={() => setRemoving(false)}>
          <h2 className="h2">Remove {sel.name}?</h2>
          <p className="sub" style={{ margin: 0 }}>Agents using this connection will need another one. The stored credential is deleted.</p>
          <div className="row"><span className="grow" /><button className="btn ghost" onClick={() => setRemoving(false)}>Cancel</button>
            <button className="btn danger-fill" onClick={async () => { setClis(await window.api.deleteCli(sel.id)); setRemoving(false); setSelId(snap.clis[0]?.id); }}>Remove</button></div>
        </Modal>
      )}
    </>
  );
}
