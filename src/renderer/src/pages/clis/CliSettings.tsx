import { useEffect, useState } from "react";
import type { CliConnection } from "@shared/types";
import { OLLAMA_SETTINGS, RUN_SETTINGS, cleanRunSettings, isRunSettingKind, ollamaValue, type ConfigFile, type ConfigFileKind, type OllamaSettingsState, type RunSettingKind, type RunSettings } from "@shared/cli-settings";
import { cleanError, useApp } from "../../store";
import { Icon } from "../../components/Icon";
import { Spinner, Toggle } from "../../components/ui";

/** Settings passed to every run of this CLI, implementation included (none loosens the sandbox). */
function RunSettingsForm({ cli, kind }: { cli: CliConnection; kind: RunSettingKind }) {
  const { setClis, toast } = useApp();
  const saved = cleanRunSettings(kind, cli.runSettings);
  const [draft, setDraft] = useState<Record<string, string | boolean>>(() => Object.fromEntries(Object.entries(saved).map(([k, v]) => [k, typeof v === "boolean" ? v : String(v)])));
  const next: RunSettings = cleanRunSettings(kind, Object.fromEntries(Object.entries(draft).map(([k, v]) => [k, typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v])));
  const invalid = RUN_SETTINGS[kind].filter((d) => typeof draft[d.key] === "string" && draft[d.key] !== "" && next[d.key] === undefined);
  const dirty = JSON.stringify(next) !== JSON.stringify(saved);
  const save = async () => {
    try {
      setClis(await window.api.saveCli({ ...cli, runSettings: next }));
      toast("success", `${cli.name} run settings saved. They apply from the next run.`);
    } catch (e) {
      toast("error", cleanError(e));
    }
  };
  return (
    <div className="well pad stack" style={{ gap: 12 }}>
      <div className="row" style={{ gap: 8 }}><b style={{ fontWeight: 600 }} className="grow">Run settings</b><span className="chip">{Object.keys(saved).length ? `${Object.keys(saved).length} set` : "CLI defaults"}</span></div>
      <span className="hint">{kind === "cline" || kind === "opencode" ? `Used when ${cli.name} implements a task.` : `Used for every run of ${cli.name}: Assessment, QA, Resolver, Elevation and implementation.`} Empty keeps the default. Settings that could loosen what Agent Dock allows (sandbox, approvals, permissions, hooks, network, MCP) are not offered, and the task scope guard always has the last word.</span>
      <div className="grid-f">
        {RUN_SETTINGS[kind].map((d) => (
          <label className="field" key={d.key} title={d.help}>
            <span>{d.label}</span>
            {d.type === "choice" ? (
              <select className="sel" value={String(draft[d.key] ?? "")} onChange={(e) => setDraft({ ...draft, [d.key]: e.target.value })}>
                <option value="">CLI default</option>
                {d.choices!.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            ) : d.type === "bool" ? (
              <div className="row" style={{ minHeight: 36 }}><Toggle on={draft[d.key] === true} label={d.label} onChange={(on) => setDraft({ ...draft, [d.key]: on })} /></div>
            ) : (
              <input className={`input ${d.type === "number" ? "tnum" : "mono"}`} inputMode={d.type === "number" ? "numeric" : undefined} value={String(draft[d.key] ?? "")} placeholder="CLI default"
                onChange={(e) => setDraft({ ...draft, [d.key]: d.type === "number" ? e.target.value.replace(/[^0-9]/g, "") : e.target.value })} />
            )}
            <span className="hint" style={{ overflowWrap: "anywhere" }}>{d.help}{d.type === "number" ? ` ${d.min!.toLocaleString()}–${d.max!.toLocaleString()}.` : ""}</span>
          </label>
        ))}
      </div>
      {invalid.length > 0 && <div className="banner"><Icon name="warn" className="warn" /><span>Not valid, so not saved: {invalid.map((d) => d.label).join(", ")}.</span></div>}
      <div className="row"><span className="sub grow">{dirty ? "Unsaved changes" : ""}</span><button className="btn ghost" disabled={!dirty} onClick={() => setDraft(Object.fromEntries(Object.entries(saved).map(([k, v]) => [k, typeof v === "boolean" ? v : String(v)])))}>Revert</button><button className="btn primary" disabled={!dirty} onClick={() => void save()}>Save</button></div>
    </div>
  );
}

/** The CLI's own config file: changes the CLI everywhere, also outside Agent Dock. */
function ConfigFileEditor({ kind, name }: { kind: ConfigFileKind; name: string }) {
  const { toast } = useApp();
  const [file, setFile] = useState<ConfigFile | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = async () => {
    setError(null);
    try {
      const f = await window.api.cliConfigFile(kind);
      setFile(f);
      setText(f.text);
    } catch (e) {
      setError(cleanError(e));
    }
  };
  useEffect(() => { void load(); }, [kind]);
  const save = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const f = await window.api.saveCliConfigFile(kind, text, file.mtimeMs);
      setFile(f);
      setText(f.text);
      toast("success", `Saved ${f.path}${file.exists ? ". The previous version is next to it as .agent-dock.bak" : ""}`);
    } catch (e) {
      toast("error", cleanError(e));
    } finally {
      setBusy(false);
    }
  };
  const dirty = file !== null && text !== file.text;
  return (
    <div className="well pad stack" style={{ gap: 10 }}>
      <div className="row" style={{ gap: 8 }}><b style={{ fontWeight: 600 }} className="grow">{name}'s own config file</b>{file && <span className="chip">{file.exists ? (kind === "codex" ? "TOML" : "JSON") : "Not created yet"}</span>}</div>
      <span className="hint">
        {file ? <span className="mono">{file.path}</span> : "Reading…"} · Changes {name} everywhere, also when you use it outside Agent Dock.
        {kind === "claude" ? " Agent Dock's runs read this file too, but their permissions, allowed tools and protection hooks are set by Agent Dock and still apply." : " Agent Dock's runs read it too, but set their own sandbox, approvals and protection hooks on top."}
      </span>
      {error ? <div className="banner errb"><Icon name="warn" className="err" /><span>{error}</span></div> : (
        <textarea className="ta mono" style={{ minHeight: 220 }} spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} placeholder={kind === "codex" ? "# config.toml\nmodel_reasoning_summary = \"concise\"" : "{\n}"} aria-label={`${name} config file`} />
      )}
      <div className="row"><span className="sub grow">{dirty ? "Unsaved changes" : ""}</span><button className="btn ghost" disabled={busy} onClick={() => void load()}><Icon name="refresh" size="sm" />Reload</button><button className="btn primary" disabled={!dirty || busy} onClick={() => void save()}>{busy && <Spinner />}Save file</button></div>
    </div>
  );
}

/** Ollama's own server settings (your user environment on Windows), and what the running Ollama uses. */
function OllamaSettingsForm({ cli }: { cli: CliConnection }) {
  const { setClis, toast } = useApp();
  const [state, setState] = useState<OllamaSettingsState | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const apply = (s: OllamaSettingsState) => {
    setState(s);
    setDraft(Object.fromEntries(OLLAMA_SETTINGS.map((d) => [d.key, s.saved[d.key] ?? ""])));
  };
  const load = async () => {
    setError(null);
    try { apply(await window.api.ollamaSettings()); } catch (e) { setError(cleanError(e)); }
  };
  useEffect(() => { void load(); }, []);
  const local = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/i.test(cli.location.trim());
  const changes = state ? Object.fromEntries(OLLAMA_SETTINGS.filter((d) => (draft[d.key] ?? "").trim() !== (state.saved[d.key] ?? "")).map((d) => [d.key, draft[d.key].trim() || null])) : {};
  const invalid = OLLAMA_SETTINGS.filter((d) => changes[d.key] && ollamaValue(d, changes[d.key]!) === null);
  const save = async () => {
    setBusy(true);
    try {
      const r = await window.api.saveOllamaSettings(changes);
      apply(r.state);
      setClis(r.clis);
      toast("success", "Saved. Quit Ollama from its tray icon and open it again to use them.");
    } catch (e) {
      toast("error", cleanError(e));
    } finally {
      setBusy(false);
    }
  };
  if (!local) return <div className="well pad sub">This connection's Ollama is on another computer ({cli.location}). Its settings are changed there.</div>;
  return (
    <div className="well pad stack" style={{ gap: 12 }}>
      <div className="row" style={{ gap: 8 }}><b style={{ fontWeight: 600 }} className="grow">Ollama's server settings</b>{state?.running?.at && <span className="chip" title="From Ollama's server.log">Running since {new Date(state.running.at).toLocaleString()}</span>}</div>
      <span className="hint">
        {state?.editable === false
          ? "On Linux and macOS, Ollama's service holds these settings (systemd or launchctl), so Agent Dock only shows what the running Ollama uses."
          : "Saved in your Windows user environment, where Ollama reads them when it starts: quit Ollama from its tray icon and open it again to use a change. Empty removes the setting, so Ollama uses its default."}
        {" "}Requests at once also sets this connection's limit for parallel tasks.
      </span>
      {error && <div className="banner errb"><Icon name="warn" className="err" /><span>{error}</span></div>}
      {state && (
        <div className="grid-f">
          {OLLAMA_SETTINGS.map((d) => {
            const running = state.running?.values[d.key];
            const savedValue = state.saved[d.key];
            // Ollama started with something else: not restarted since, or its own settings window overrides it.
            const differs = savedValue !== null && running !== undefined && running !== savedValue && !(d.type === "duration" && running.startsWith(savedValue));
            return (
              <label className="field" key={d.key} title={d.help}>
                <span style={{ overflowWrap: "anywhere" }}>{d.label} <span className="mono mut" style={{ fontSize: 11 }}>{d.key}</span></span>
                {d.type === "choice" || d.type === "bool" ? (
                  <select className="sel" disabled={!state.editable} value={draft[d.key] ?? ""} onChange={(e) => setDraft({ ...draft, [d.key]: e.target.value })}>
                    <option value="">Ollama default</option>
                    {(d.type === "bool" ? [["1", "On"], ["0", "Off"]] : d.choices!.map((c) => [c, c])).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                ) : (
                  <input className={`input ${d.type === "number" ? "tnum" : "mono"}`} disabled={!state.editable} value={draft[d.key] ?? ""} placeholder="Ollama default" onChange={(e) => setDraft({ ...draft, [d.key]: e.target.value })} />
                )}
                <span className={`hint ${differs ? "warn" : ""}`} style={{ overflowWrap: "anywhere" }}>
                  {running !== undefined ? `Running Ollama uses: ${running || "(default)"}.` : "Running Ollama: not known."}
                  {differs ? " Not what is saved: restart Ollama, or its own settings window overrides this." : ""} {d.help}
                </span>
              </label>
            );
          })}
        </div>
      )}
      {invalid.length > 0 && <div className="banner"><Icon name="warn" className="warn" /><span>Not valid: {invalid.map((d) => d.label).join(", ")}.</span></div>}
      <div className="row"><span className="sub grow">{Object.keys(changes).length ? "Unsaved changes" : ""}</span><button className="btn ghost" disabled={busy} onClick={() => void load()}><Icon name="refresh" size="sm" />Reload</button><button className="btn primary" disabled={!state?.editable || !Object.keys(changes).length || invalid.length > 0 || busy} onClick={() => void save()}>{busy && <Spinner />}Save</button></div>
    </div>
  );
}

/** CLIs › Settings: run settings (Codex, Claude Code, Cline, OpenCode), Codex's and Claude Code's config file, and Ollama's server. */
export function CliSettings({ cli }: { cli: CliConnection }) {
  if (isRunSettingKind(cli.kind)) {
    return (
      <div className="stack fade-in" style={{ gap: 14 }}>
        <RunSettingsForm key={cli.id + JSON.stringify(cli.runSettings ?? {})} cli={cli} kind={cli.kind} />
        {/* Cline and OpenCode run with their own config isolated: there is no file of theirs to edit. */}
        {(cli.kind === "codex" || cli.kind === "claude") && <ConfigFileEditor kind={cli.kind} name={cli.name} />}
      </div>
    );
  }
  if (cli.kind === "ollama") return <div className="stack fade-in"><OllamaSettingsForm cli={cli} /></div>;
  return null;
}

export const hasCliSettings = (cli: CliConnection) => isRunSettingKind(cli.kind) || cli.kind === "ollama";
