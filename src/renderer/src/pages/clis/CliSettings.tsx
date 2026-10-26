import { useEffect, useState } from "react";
import type { CliConnection } from "@shared/types";
import { OLLAMA_SETTINGS, RUN_SETTINGS, cleanRunSettings, isRunSettingKind, type ConfigFile, type ConfigFileKind, type OllamaSettingsState, type RunSettingKind, type RunSettings } from "@shared/cli-settings";
import { cleanError, useApp } from "../../store";
import { Icon } from "../../components/Icon";
import { Toggle } from "../../components/ui";

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

/** Where the CLI's own config file is. Agent Dock does not edit it: it changes the CLI everywhere. */
function ConfigFileLink({ kind, name }: { kind: ConfigFileKind; name: string }) {
  const { toast } = useApp();
  const [file, setFile] = useState<ConfigFile | null>(null);
  useEffect(() => { void window.api.cliConfigFile(kind).then(setFile, (e) => toast("error", cleanError(e))); }, [kind]);
  const show = async () => {
    try {
      const problem = await window.api.showCliConfigFile(kind);
      if (problem) toast("info", problem);
    } catch (e) {
      toast("error", cleanError(e));
    }
  };
  return (
    <div className="well pad stack" style={{ gap: 10 }}>
      <div className="row" style={{ gap: 8 }}><b style={{ fontWeight: 600 }} className="grow">{name}'s own config file</b>{file && !file.exists && <span className="chip">Not created yet</span>}</div>
      <span className="hint">
        {file ? <span className="mono">{file.path}</span> : "Reading…"} · Edit it in your own editor: it changes {name} everywhere, also when you use it outside Agent Dock.
        {kind === "claude" ? " Agent Dock's runs read this file too, but their permissions, allowed tools and protection hooks are set by Agent Dock and still apply." : " Agent Dock's runs read it too, but set their own sandbox, approvals and protection hooks on top."}
      </span>
      <div className="row"><span className="grow" /><button className="btn" disabled={!file || (!file.exists && !file.folderExists)} onClick={() => void show()}><Icon name="external" size="sm" />{file?.exists === false ? "Show its folder" : "Show config file"}</button></div>
    </div>
  );
}

const OLLAMA_FAQ = "https://github.com/ollama/ollama/blob/main/docs/faq.md#how-do-i-configure-ollama-server";
const shownValue = (key: string, value: string) => (key === "OLLAMA_FLASH_ATTENTION" ? (value === "1" ? "On" : value === "0" ? "Off" : value) : value);

/** Ollama's own server settings as your environment and the running Ollama have them. Agent Dock does not change them. */
function OllamaSettingsView({ cli }: { cli: CliConnection }) {
  const [state, setState] = useState<OllamaSettingsState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = async () => {
    setError(null);
    try { setState(await window.api.ollamaSettings()); } catch (e) { setError(cleanError(e)); }
  };
  useEffect(() => { void load(); }, []);
  const local = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/i.test(cli.location.trim());
  if (!local) return <div className="well pad sub">This connection's Ollama is on another computer ({cli.location}). Its settings are there.</div>;
  return (
    <div className="well pad stack" style={{ gap: 12 }}>
      <div className="row" style={{ gap: 8 }}><b style={{ fontWeight: 600 }} className="grow">Ollama's server settings</b>{state?.running?.at && <span className="chip" title="From Ollama's server.log">Running since {new Date(state.running.at).toLocaleString()}</span>}</div>
      <span className="hint">
        What Ollama uses. Change them in Ollama's own settings window or as environment variables (on Linux and macOS, on Ollama's service), then restart Ollama.
        {" "}<a href={OLLAMA_FAQ} target="_blank" rel="noreferrer">How to configure Ollama</a>. Requests at once is also set on the Connection tab.
      </span>
      {error && <div className="banner errb"><Icon name="warn" className="err" /><span>{error}</span></div>}
      {state && (
        <div className="grid-f">
          {OLLAMA_SETTINGS.map((d) => {
            const running = state.running?.values[d.key];
            const savedValue = state.saved[d.key];
            // Ollama started with something else: not restarted since, or its own settings window overrides it.
            const differs = savedValue !== null && running !== undefined && running !== savedValue && !(d.key === "OLLAMA_KEEP_ALIVE" && running.startsWith(savedValue));
            return (
              <div className="field" key={d.key} title={d.help}>
                <span style={{ overflowWrap: "anywhere" }}>{d.label} <span className="mono mut" style={{ fontSize: 11 }}>{d.key}</span></span>
                <span className="mono" style={{ overflowWrap: "anywhere" }}>{running !== undefined ? shownValue(d.key, running) || "(default)" : "Not known"}</span>
                <span className={`hint ${differs ? "warn" : ""}`} style={{ overflowWrap: "anywhere" }}>
                  {savedValue !== null ? `Your environment: ${shownValue(d.key, savedValue)}.` : ""}
                  {differs ? " Not what Ollama uses: restart Ollama, or its own settings window overrides this." : ""} {d.help}
                </span>
              </div>
            );
          })}
        </div>
      )}
      {state && !state.running && <span className="hint">Ollama's server.log was not found, so what the running Ollama uses is not known.</span>}
      <div className="row"><span className="grow" /><button className="btn ghost" onClick={() => void load()}><Icon name="refresh" size="sm" />Reload</button></div>
    </div>
  );
}

/** CLIs › Settings: run settings (Codex, Claude Code, Cline, OpenCode), where Codex's and Claude Code's config file is, and Ollama's server settings. */
export function CliSettings({ cli }: { cli: CliConnection }) {
  if (isRunSettingKind(cli.kind)) {
    return (
      <div className="stack fade-in" style={{ gap: 14 }}>
        <RunSettingsForm key={cli.id + JSON.stringify(cli.runSettings ?? {})} cli={cli} kind={cli.kind} />
        {/* Cline and OpenCode run with their own config isolated: there is no file of theirs to show. */}
        {(cli.kind === "codex" || cli.kind === "claude") && <ConfigFileLink kind={cli.kind} name={cli.name} />}
      </div>
    );
  }
  if (cli.kind === "ollama") return <div className="stack fade-in"><OllamaSettingsView cli={cli} /></div>;
  return null;
}

export const hasCliSettings = (cli: CliConnection) => isRunSettingKind(cli.kind) || cli.kind === "ollama";
