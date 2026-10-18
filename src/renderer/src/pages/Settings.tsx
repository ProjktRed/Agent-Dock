import { useEffect, useState } from "react";
import type { Agent, EngineTuning, LibraryPreview, Settings, SkillInfo } from "@shared/types";
import { DEFAULT_SETTINGS } from "@shared/defaults";
import { useApp } from "../store";
import { Updates } from "./Updates";
import { connectionMeta, roleLabel, tokens } from "../lib/format";
import { Icon } from "../components/Icon";
import { Empty, Modal, ProvenanceChip, SetRow, St, Support, Tabs, Toggle } from "../components/ui";

type Section = "general" | "skills" | "workflow" | "context" | "safety" | "updates" | "advanced";
const SECTIONS: { value: Section; label: string }[] = [
  { value: "general", label: "General" },
  { value: "skills", label: "Skills" },
  { value: "workflow", label: "Workflow rules" },
  { value: "context", label: "Context limits" },
  { value: "safety", label: "Execution & safety" },
  { value: "updates", label: "Updates" },
  { value: "advanced", label: "Advanced" },
];
/** Unattended limits that keep their decimals; the others are whole counts. */
const DECIMAL_LIMITS = new Set<string>(["maxHours", "maxMillionTokens", "maxCostUsd", "maxMillionTokensDay", "maxCostUsdDay"]);
const ACCENTS = [
  ["Pastel blue", "#82A9E8"],
  ["Lavender", "#AD9ADA"],
  ["Mint", "#70C7A5"],
  ["Amber", "#DAB777"],
  ["Rose", "#D98291"],
];

function useSettingsPatch() {
  const { snap, saveSettings } = useApp();
  return <K extends keyof Settings>(key: K, patch: Partial<Settings[K]>) =>
    saveSettings({ ...snap.settings, [key]: { ...(snap.settings[key] as object), ...patch } as Settings[K] });
}

/**
 * A loop limit the engine fixes while guardrails are on. Guardrails on: the engine's value, locked.
 * Off: editable; saved on blur. Null-able values (engine defaults) clear to the default when emptied.
 */
function Tunable({ k, min, max, unit, zeroLabel, fallback, label }: { k: keyof EngineTuning; min: number; max: number; unit?: string; zeroLabel?: string; fallback?: number; label: string }) {
  const { snap } = useApp();
  const patch = useSettingsPatch();
  const guarded = snap.settings.advanced.engineGuardrails !== false;
  const stored = snap.settings.tuning[k];
  const engineValue = (DEFAULT_SETTINGS.tuning[k] ?? fallback) as number;
  const value = (guarded ? engineValue : stored ?? fallback) as number;
  const [text, setText] = useState(stored == null ? "" : String(stored));
  useEffect(() => setText(stored == null ? "" : String(stored)), [stored]);
  const unitFor = (v: number) => (unit && v === 1 && /s$/.test(unit) ? unit.slice(0, -1) : unit);
  const show = (v: number) => (v === 0 && zeroLabel ? zeroLabel : `${v.toLocaleString()}${unit ? ` ${unitFor(v)}` : ""}`);
  if (guarded) {
    return (
      <span className="row" style={{ gap: 10 }}>
        <span className="mono">{show(value)}</span>
        <span className="lock" title="Turn off engine guardrails (Settings › Advanced) to change"><Icon name="lock" size="sm" />Fixed by engine</span>
      </span>
    );
  }
  const commit = () => {
    const raw = text.replace(/[\s,]/g, "");
    if (raw === "" && fallback !== undefined) return void patch("tuning", { [k]: null } as Partial<EngineTuning>);
    const next = Number(raw);
    if (Number.isInteger(next) && next >= min && next <= max) {
      if (next !== stored) void patch("tuning", { [k]: next } as Partial<EngineTuning>);
    } else setText(stored == null ? "" : String(stored));
  };
  return (
    <span className="row" style={{ gap: 8 }}>
      <input className="input mono" style={{ width: 110 }} inputMode="numeric" value={text} placeholder={fallback !== undefined ? fallback.toLocaleString() : undefined} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} aria-label={label} />
      {unit && <span className="sub">{unit}</span>}
      {zeroLabel && <span className="hint">0 = {zeroLabel.toLowerCase()}</span>}
    </span>
  );
}

function GuardrailsNote() {
  const { snap } = useApp();
  if (snap.settings.advanced.engineGuardrails === false) return <div className="banner warnb"><Icon name="warn" className="warn" /><span>Engine guardrails are off: the values below are passed to the engine. Defaults reproduce the engine's built-in behaviour.</span></div>;
  return <div className="banner"><Icon name="lock" className="info" /><span>Values marked <b>Fixed by engine</b> become editable when you turn off engine guardrails (Settings › Advanced).</span></div>;
}

function General() {
  const { snap } = useApp();
  const g = snap.settings.general;
  const patch = useSettingsPatch();
  return (
    <div className="stack" style={{ gap: 20 }}>
      <section className="card pad">
        <h2 className="h2" style={{ marginBottom: 4 }}>Startup and window</h2>
        <SetRow title="Launch when Windows starts" desc="Registers the app as a Windows sign-in item" support="app"><Toggle on={g.launchAtStartup} onChange={(v) => patch("general", { launchAtStartup: v })} label="Launch at startup" /></SetRow>
        <SetRow title="Start minimized" desc="Open to the system tray instead of a window" support="app"><Toggle on={g.startMinimized} onChange={(v) => patch("general", { startMinimized: v })} label="Start minimized" /></SetRow>
        <SetRow title="Keep running in the system tray when the window closes" desc="The engine runs in its own process either way; this keeps notifications and the tray status alive" support="app"><Toggle on={g.keepInTray} onChange={(v) => patch("general", { keepInTray: v })} label="Keep running in tray" /></SetRow>
      </section>
      <section className="card pad">
        <h2 className="h2" style={{ marginBottom: 4 }}>Appearance</h2>
        <SetRow title="Theme" support="app">
          <Tabs label="Theme" small value={g.theme} onChange={(v) => patch("general", { theme: v })} options={[{ value: "dark", label: "Dark" }, { value: "darker", label: "Darker" }]} />
        </SetRow>
        <SetRow title="Accent color" desc="Focus, selection and primary actions" support="app">
          <div className="row" style={{ gap: 14 }}>
            {ACCENTS.map(([name, hex]) => <button key={hex} className={`swatch ${g.accent.toUpperCase() === hex ? "on" : ""}`} style={{ background: hex }} aria-label={name} aria-pressed={g.accent.toUpperCase() === hex} onClick={() => patch("general", { accent: hex })} />)}
          </div>
        </SetRow>
      </section>
      <section className="card pad">
        <h2 className="h2" style={{ marginBottom: 4 }}>Notifications</h2>
        <SetRow title="Attention required and blocked" desc="Windows notification. Always on: these stop the workflow for your decision." support="app"><span className="lock"><Icon name="lock" size="sm" />Always on</span><Toggle on label="Attention notifications" disabled /></SetRow>
        <SetRow title="Task approved" desc="One notification per task that passes QA" support="app"><Toggle on={g.notifyCompleted} onChange={(v) => patch("general", { notifyCompleted: v })} label="Task approved notifications" /></SetRow>
        <SetRow title="Usage limits and engine exits" support="app"><Toggle on={g.notifyErrors} onChange={(v) => patch("general", { notifyErrors: v })} label="Error notifications" /></SetRow>
      </section>
      <section className="card pad">
        <h2 className="h2" style={{ marginBottom: 4 }}>Defaults</h2>
        <SetRow title="Project on launch" support="app">
          <label className="sr" htmlFor="defp">Default project</label>
          <select id="defp" className="sel" value={g.defaultProject} onChange={(e) => patch("general", { defaultProject: e.target.value })}>
            <option value="last">Last active project</option>
            {snap.projects.filter((p) => !p.archived).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </SetRow>
      </section>
    </div>
  );
}

/** GitHub import: preview pins one commit, downloads only text files and scans them; nothing is written until Import. */
function SkillImport({ onClose, onImported }: { onClose: () => void; onImported: (skills: SkillInfo[]) => void }) {
  const { toast } = useApp();
  const [libraries, setLibraries] = useState<{ label: string; url: string }[]>([]);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<LibraryPreview | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  useEffect(() => { void window.api.skillLibraries().then(setLibraries); }, []);
  const load = async (target = url, only?: string[]) => {
    setBusy(true); setPreview(null); setChosen([]); setConfirmed(false);
    try { setPreview(await window.api.previewSkillImport(target, only)); } catch (e) { toast("error", e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const importable = (preview?.skills ?? []).filter((sk) => !sk.findings.some((x) => x.level === "block"));
  const key = (sk: { name: string; path: string }) => (preview?.browse ? sk.path : sk.name);
  const warned = (preview?.skills ?? []).some((sk) => chosen.includes(sk.name) && sk.findings.some((x) => x.level === "warn"));
  const install = async () => {
    if (!preview) return;
    setBusy(true);
    try { onImported(await window.api.installSkillImport(preview.token, chosen)); toast("success", `Imported ${chosen.length} skill(s)`); onClose(); }
    catch (e) { toast("error", e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  return (
    <Modal title="Import skills from GitHub" label="Import skills from GitHub" onClose={onClose} wide>
      <div className="stack" style={{ gap: 14 }}>
        <div className="row wrap" style={{ gap: 8 }}>
          <span className="sub">Trusted libraries:</span>
          {libraries.map((l) => <button key={l.url} className="chip btnlike raised info" disabled={busy} onClick={() => { setUrl(l.url); void load(l.url); }}>{l.label}</button>)}
        </div>
        <div className="row" style={{ gap: 8 }}>
          <input className="input mono grow" value={url} placeholder="https://github.com/owner/repo/tree/main/skills/name" onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === "Enter" && url.trim() && void load()} aria-label="GitHub URL" />
          <button className="btn" disabled={busy || !url.trim()} onClick={() => void load()}>{busy && !preview ? "Checking…" : "Preview"}</button>
        </div>
        <p className="sub" style={{ margin: 0 }}>Imports are pinned to one commit. Only text files are downloaded; scripts and binaries are skipped and never run. Skills are scanned for hidden characters and risky instructions before you import.</p>
        {preview && (
          <>
            <div className={`banner ${preview.trusted ? "" : "warnb"}`}><Icon name={preview.trusted ? "lock" : "warn"} className={preview.trusted ? "info" : "warn"} /><span><span className="mono">{preview.owner}/{preview.repo}</span> at commit <span className="mono">{preview.commit.slice(0, 7)}</span>{preview.trusted ? " · trusted library" : " · not a trusted library: read every file before importing"}</span></div>
            <div className="row" style={{ gap: 8 }}>
              <span className="sub grow">{preview.browse ? `${preview.skills.length} skills in this library. Choose up to 60 to download and review.` : `${importable.length} of ${preview.skills.length} can be imported.`}{chosen.length ? ` ${chosen.length} selected.` : ""}</span>
              <button className="btn sm" onClick={() => setChosen(chosen.length ? [] : preview.browse ? preview.skills.slice(0, 60).map((sk) => sk.path) : importable.map((sk) => sk.name))}>{chosen.length ? "Select none" : preview.browse && preview.skills.length > 60 ? "Select first 60" : "Select all"}</button>
            </div>
            <section className="well" style={{ padding: 6, maxHeight: 340, overflowY: "auto" }}>
              {preview.skills.map((sk) => {
                const blocked = sk.findings.some((x) => x.level === "block");
                const on = chosen.includes(key(sk));
                return (
                  <label key={key(sk)} className="stack" style={{ gap: 4, padding: "8px 10px", opacity: blocked ? 0.6 : 1 }}>
                    <span className="row" style={{ gap: 8 }}>
                      <input type="checkbox" disabled={blocked} checked={on} onChange={() => setChosen(on ? chosen.filter((n) => n !== key(sk)) : [...chosen, key(sk)])} />
                      <span style={{ fontWeight: 600 }}>{sk.name}</span>
                      <span className="sub ellipsis grow">{sk.description}</span>
                      {!preview.browse && <span className="sub">{sk.files.length} file(s){sk.skipped.length ? ` · ${sk.skipped.length} skipped` : ""}</span>}
                    </span>
                    {sk.findings.filter((x) => x.file || x.level === "block").map((x, i) => <span key={i} className={`row ${x.level === "block" ? "err" : "warn"}`} style={{ gap: 6, fontSize: 12, paddingLeft: 26 }}><Icon name="warn" size="sm" />{x.level === "block" ? "Blocked: " : ""}{x.message}{x.file ? <span className="mono sub"> {x.file}</span> : null}</span>)}
                  </label>
                );
              })}
            </section>
            {warned && <label className="row" style={{ gap: 8 }}><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} /><span>I reviewed the warnings and want to import these skills.</span></label>}
            <div className="row" style={{ gap: 8 }}>
              <span className="grow" />
              <button className="btn" onClick={onClose}>Cancel</button>
              {preview.browse
                ? <button className="btn primary" disabled={busy || !chosen.length || chosen.length > 60} onClick={() => void load(preview.url, chosen)}>Review {chosen.length || ""}</button>
                : <button className="btn primary" disabled={busy || !chosen.length || (warned && !confirmed)} onClick={() => void install()}>Import {chosen.length || ""}</button>}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

function Skills() {
  const { snap, setAgents, saveSettings, toast } = useApp();
  const [skills, setSkills] = useState<SkillInfo[] | null>(null);
  const [selId, setSelId] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  useEffect(() => {
    void window.api.skills().then((s) => {
      setSkills(s);
      setSelId(s[0]?.id ?? null);
    });
  }, []);
  if (!skills) return <div className="skel" style={{ width: "50%" }} />;
  const sel = skills.find((s) => s.id === selId) ?? null;
  const enabled = (s: SkillInfo) => snap.settings.skills.enabled[s.id] ?? true;
  const assigned = (s: SkillInfo) => snap.agents.filter((a) => a.skills.includes(s.name) || (a.autoSkills ?? []).includes(s.name) || (a.role === "implementation" && a.autoAllImported !== false && s.source === "imported" && enabled(s)));
  const assignedLabel = (s: SkillInfo) => assigned(s).map((a) => (a.skills.includes(s.name) ? a.name : `${a.name} (when relevant)`)).join(", ");
  // Grouped by source: the engine's own skill, each GitHub library, and folder imports. Large groups start collapsed.
  const groupOf = (s: SkillInfo) => (s.source === "engine" ? "Engine" : s.origin ? s.origin.split("@")[0] : "Imported from folder");
  const groups = [...new Set(skills.map(groupOf))].map((name) => ({ name, items: skills.filter((s) => groupOf(s) === name) }));
  const isCollapsed = (g: { name: string; items: SkillInfo[] }) => collapsed[g.name] ?? g.items.length > 8;
  const setAll = (value: boolean) => setCollapsed(Object.fromEntries(groups.map((g) => [g.name, value])));
  const setGroupEnabled = (items: SkillInfo[], value: boolean) =>
    saveSettings({ ...snap.settings, skills: { ...snap.settings.skills, enabled: { ...snap.settings.skills.enabled, ...Object.fromEntries(items.map((s) => [s.id, value])) } } });
  const toggleAgent = async (agent: Agent, skill: SkillInfo) => {
    const has = agent.skills.includes(skill.name);
    setAgents(await window.api.saveAgent({ ...agent, skills: has ? agent.skills.filter((x) => x !== skill.name) : [...agent.skills, skill.name] }));
  };
  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="banner"><Icon name="warn" className="info" /><span>The engine always includes its bundled <span className="mono">bounded-task-handoff</span> skill. Skills you assign to an agent are added to that role's prompt (SKILL.md plus its other Markdown files when they fit 16,000 characters); task scope and guard rules still take precedence.</span></div>
      <div className="row wrap" style={{ gap: 12 }}>
        <span className="sub grow">{skills.length} skills · {skills.filter((s) => s.source === "engine").length} bundled with the engine</span>
        {groups.length > 1 && <>
          <button className="btn ghost sm" onClick={() => setAll(false)}><Icon name="chevronDown" size="sm" />Expand all</button>
          <button className="btn ghost sm" onClick={() => setAll(true)}><Icon name="chevronRight" size="sm" />Collapse all</button>
        </>}
        <button className="btn" onClick={() => setImporting(true)}><Icon name="download" size="sm" />Import from GitHub</button>
        <button className="btn" onClick={async () => setSkills(await window.api.importSkillFolder())}><Icon name="download" size="sm" />Import from folder</button>
      </div>
      {skills.length === 0 ? <Empty title="No skills found" icon="settings" /> : (
        <section className="well scroll-x" style={{ padding: 6 }}>
          <table className="tbl" style={{ minWidth: 720 }}>
            <thead><tr><th>Skill</th><th>Source</th><th>Assigned to</th><th>Compatibility</th><th>Enabled</th></tr></thead>
            {groups.map((g) => {
              const shut = isCollapsed(g);
              const imported = g.items.filter((s) => s.source !== "engine");
              const on = imported.filter(enabled).length;
              return (
            <tbody key={g.name}>
              <tr className="click" onClick={() => setCollapsed({ ...collapsed, [g.name]: !shut })} aria-expanded={!shut}>
                <td colSpan={4}>
                  <span className="row" style={{ gap: 8, fontWeight: 600 }}>
                    <Icon name={shut ? "chevronRight" : "chevronDown"} size="sm" />
                    <span className={g.name === "Engine" || g.name === "Imported from folder" ? "" : "mono"}>{g.name}</span>
                    <span className="sub" style={{ fontWeight: 400 }}>{g.items.length} skill{g.items.length === 1 ? "" : "s"}{imported.length ? ` · ${on} enabled` : ""}</span>
                  </span>
                </td>
                <td onClick={(e) => e.stopPropagation()}>{imported.length > 1 && <button className="btn ghost sm" onClick={() => setGroupEnabled(imported, on < imported.length)}>{on < imported.length ? "Enable all" : "Disable all"}</button>}</td>
              </tr>
              {!shut && g.items.map((s) => (
                <tr key={s.id} className={`click ${s.id === selId ? "sel" : ""}`} onClick={() => setSelId(s.id)}>
                  <td><button className="rowbtn"><span className="name" style={{ fontWeight: 600 }}>{s.name}</span><span className="sub ellipsis" style={{ maxWidth: 300 }}>{s.description}</span></button></td>
                  <td><span className={`chip ${s.source === "engine" ? "info" : "lav"}`} title={s.origin}>{s.source === "engine" ? "Engine" : s.origin ? "GitHub" : "Imported"}</span>{s.origin && <span className="sub mono" style={{ display: "block", fontSize: 11 }}>{s.origin}</span>}</td>
                  <td className="sub">{assignedLabel(s) || "None"}</td>
                  <td><span className={`row ${s.warnings.length ? "warn" : "ok"}`} style={{ gap: 6, fontSize: 12 }}><span className="dot" />{s.warnings.length ? `${s.warnings.length} warning(s)` : "Compatible"}</span></td>
                  <td onClick={(e) => e.stopPropagation()}>{s.source === "engine" ? <span className="lock"><Icon name="lock" size="sm" />Required</span> : <Toggle on={enabled(s)} onChange={(v) => saveSettings({ ...snap.settings, skills: { ...snap.settings.skills, enabled: { ...snap.settings.skills.enabled, [s.id]: v } } })} label={`Enable ${s.name}`} />}</td>
                </tr>
              ))}
            </tbody>
              );
            })}
          </table>
        </section>
      )}
      {importing && <SkillImport onClose={() => setImporting(false)} onImported={setSkills} />}
      {sel && (
        <section className="card pad stack" style={{ gap: 16 }}>
          <div className="row wrap"><h2 className="h2">{sel.name}</h2><span className="grow" /><button className="btn ghost sm" onClick={() => window.api.openPath(sel.dir)}><Icon name="external" size="sm" />Open folder</button></div>
          {sel.warnings.map((w) => <div className="banner warnb" key={w}><Icon name="warn" className="warn" /><span>{w}</span></div>)}
          <p className="sub" style={{ margin: 0 }}>{sel.description}</p>
          <div className="field">
            <span className="row" style={{ gap: 8 }}>Assign to agents<Support kind="saved" /></span>
            <div className="row wrap" style={{ gap: 8 }}>
              {snap.agents.map((a) => {
                const on = a.skills.includes(sel.name);
                return <button key={a.id} className={`chip btnlike ${on ? "raised info" : "mut"}`} aria-pressed={on} onClick={() => toggleAgent(a, sel).catch((e) => toast("error", String(e)))}>{a.name}</button>;
              })}
            </div>
          </div>
          <div className="field"><span>Instructions (read-only)</span><div className="mono log selectable">{sel.instructions}</div></div>
        </section>
      )}
    </div>
  );
}

function Workflow() {
  const { snap, setAgents, activeProject, activeStatus, control, toast } = useApp();
  const w = snap.settings.workflow;
  const a = snap.settings.attention;
  const patch = useSettingsPatch();
  const setDefault = async (role: Agent["role"], id: string) => {
    let list = snap.agents;
    for (const agent of snap.agents.filter((x) => x.role === role)) list = await window.api.saveAgent({ ...agent, enabled: agent.id === id });
    setAgents(list);
    toast("success", `Default ${roleLabel[role]} agent updated`);
  };
  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="banner"><Icon name="lock" className="warn" /><span>The engine never lets unsafe work through automatically: only QA commits, PASS must be exactly one commit touching only the task's approved paths, non-PASS must leave HEAD unchanged, and scope, HEAD, permission or state problems always stop for you. Automatic continuation cannot bypass this.</span></div>
      <section className="card pad stack" style={{ gap: 14 }}>
        <div className="row" style={{ gap: 8 }}><h2 className="h2">Default agents per role</h2><Support kind="engine" /></div>
        <div className="grid-4">
          {(["implementation", "qa", "assessment", "elevation"] as const).map((role) => {
            const candidates = snap.agents.filter((x) => x.role === role);
            const current = candidates.find((x) => x.enabled);
            return (
              <label className="field" key={role}><span>{roleLabel[role]}</span>
                <select className="sel" value={current?.id ?? ""} onChange={(e) => setDefault(role, e.target.value)}>
                  {!current && <option value="">None enabled</option>}
                  {candidates.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </label>
            );
          })}
        </div>
        <span className="hint">Choosing a default enables that agent and disables other agents with the same role. Projects can still override a role.</span>
      </section>
      <section className="card pad">
        <h2 className="h2" style={{ marginBottom: 4 }}>Loop behaviour</h2>
        <GuardrailsNote />
        <SetRow title="Automatic continuation" desc="Start the next task as soon as one is approved. Off: the app requests Pause After Task whenever QA passes." support="app"><Toggle on={w.autoContinue} onChange={(v) => patch("workflow", { autoContinue: v })} label="Automatic continuation" /></SetRow>
        <SetRow title="Automatic elevation" desc="One short Elevation reassessment when Assessment corrections stall. Its advice still goes through independent QA." support="engine"><Toggle on={w.automaticElevation} onChange={(v) => patch("workflow", { automaticElevation: v })} label="Automatic elevation" /></SetRow>
        <SetRow title="Elevation after" desc="Attempted Assessment corrections before automatic Elevation reassesses the strategy (when Automatic elevation is on)" support="engine"><Tunable k="elevationAfter" min={1} max={50} unit="corrections" label="Elevation after corrections" /></SetRow>
        <SetRow title="Correction limit" desc="QA failures get a bounded correction from Assessment. With a limit, the loop stops for you after that many corrections on one task; Resume allows another round." support="engine"><Tunable k="maxCorrections" min={0} max={500} zeroLabel="No limit" label="Correction limit" /></SetRow>
        <SetRow title="Resolver strategies" desc="Blocked cases: the read-only Resolver runs once all workers are idle. Distinct recovery strategies per task before human review." support="engine"><Tunable k="resolverMaxStrategies" min={1} max={20} unit="per task" label="Resolver strategies per task" /></SetRow>
        <SetRow title="After the app restarts" desc="When a project was mid-task and its engine is no longer running" support="app">
          <select className="sel" value={w.resumeAfterRestart} onChange={(e) => patch("workflow", { resumeAfterRestart: e.target.value as typeof w.resumeAfterRestart })} aria-label="Resume behaviour">
            <option value="ask">Show a notice</option><option value="auto">Resume automatically</option><option value="paused">Stay stopped</option>
          </select>
        </SetRow>
        <SetRow title="Stop after current task" desc={activeProject ? `One-off request for ${activeProject.name}` : "Select a project first"} support="engine">
          <button className="btn sm" disabled={!activeStatus?.processAlive} onClick={() => activeProject && control(activeProject.id, "stop-after-task", "Will stop once the current task finishes")}>Request</button>
        </SetRow>
      </section>
      <section className="card pad stack" style={{ gap: 10 }}>
        <div className="row" style={{ gap: 8 }}><h2 className="h2">User attention policy</h2><Support kind="app" /></div>
        <p className="sub" style={{ margin: 0 }}>Attention can notify you without stopping development. Each level escalates only as far as it needs to.</p>
        <div className="well scroll-x" style={{ padding: 6 }}>
          <table className="tbl" style={{ minWidth: 720 }}>
            <thead><tr><th>Level</th><th>Engine behaviour</th><th>Notify via</th></tr></thead>
            <tbody>
              <tr><td><span className="row" style={{ gap: 8 }}><span className="dot info" /><b style={{ fontWeight: 600 }}>Informational</b></span></td><td className="sub">Context compaction and similar events. Work continues.</td>
                <td><select className="sel" value={a.informational} onChange={(e) => patch("attention", { informational: e.target.value as typeof a.informational })} aria-label="Informational channel"><option value="in-app">In-app only</option><option value="windows">Windows notification</option><option value="off">Off</option></select></td></tr>
              <tr><td><span className="row" style={{ gap: 8 }}><span className="dot warn" /><b style={{ fontWeight: 600 }}>Recommends pause</b></span></td><td className="sub">Usage limit reached: the engine waits for Resume, other projects continue.</td>
                <td><select className="sel" value={a.recommendPause} onChange={(e) => patch("attention", { recommendPause: e.target.value as typeof a.recommendPause })} aria-label="Recommend pause channel"><option value="windows">Windows notification</option><option value="in-app">In-app only</option></select></td></tr>
              <tr><td><span className="row" style={{ gap: 8 }}><span className="dot attn" /><b style={{ fontWeight: 600 }}>Mandatory review</b></span></td><td className="sub">Manual review: this project stops until you Elevate or Resume. Never auto-approved. <span className="lock">Locked</span></td><td className="sub">Windows notification + tray badge</td></tr>
              <tr><td><span className="row" style={{ gap: 8 }}><span className="dot err" /><b style={{ fontWeight: 600 }}>Hard blocker</b></span></td><td className="sub">Scope, HEAD, permission or state failure: safe continuation is impossible. <span className="lock">Locked</span></td><td className="sub">Windows notification + tray badge</td></tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function Context() {
  const { snap, healths, setAgents } = useApp();
  const patch = useSettingsPatch();
  const impl = snap.agents.filter((x) => x.role === "implementation" && snap.clis.find((c) => c.id === x.cliId)?.kind === "cline");
  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="row wrap sub" style={{ gap: 18 }}>
        <span className="row" style={{ gap: 6 }}><ProvenanceChip value="reported" />Defined by the provider or hardware, read-only</span>
        <span className="row" style={{ gap: 6 }}><span className="chip lav" style={{ height: 18, fontSize: 10.5 }}>Yours</span>Limit you configure; must not exceed the provider's</span>
      </div>
      <section className="card pad">
        <h2 className="h2" style={{ marginBottom: 4 }}>Defaults</h2>
        <GuardrailsNote />
        <SetRow title="Default context window" desc="Used for new Implementation agents on Cline" support="engine"><Tunable k="defaultContextTokens" min={1024} max={10_000_000} fallback={snap.engine.defaults.contextTokens} unit="tokens" label="Default context window" /></SetRow>
        <SetRow title="Default maximum output" desc="Used for new Implementation agents on Cline" support="engine"><Tunable k="defaultMaxOutputTokens" min={256} max={1_000_000} fallback={snap.engine.defaults.maxOutputTokens} unit="tokens" label="Default maximum output" /></SetRow>
        <SetRow title="Context warning threshold" desc="Warn when a configured context reaches this share of the model's reported maximum" support="app">
          <input type="range" min={50} max={95} step={5} value={snap.settings.context.warnThresholdPercent} onChange={(e) => patch("context", { warnThresholdPercent: Number(e.target.value) })} aria-label="Warning threshold" style={{ accentColor: "var(--a)", width: 200 }} />
          <span className="mono" style={{ width: 40 }}>{snap.settings.context.warnThresholdPercent}%</span>
        </SetRow>
        <SetRow title="Compaction" desc="Cline compacts its own history; compaction events are counted on the Token tab" support="engine"><span className="chip mut">Managed by Cline</span></SetRow>
        <SetRow title="Files per task" desc="Assessment sizes tasks for the implementation worker. 1 = one file per task where possible." support="engine"><Tunable k="taskMaxFiles" min={1} max={50} unit="files" label="Files per task" /></SetRow>
        <SetRow title="New file size" desc="Assessment keeps each new file under about this many lines" support="engine"><Tunable k="taskMaxNewLines" min={10} max={5000} unit="lines" label="New file size" /></SetRow>
        <SetRow title="Files to read" desc="Assessment names at most this many files for the worker to read (with line ranges for large files)" support="engine"><Tunable k="taskMaxReadFiles" min={1} max={50} unit="files" label="Files to read" /></SetRow>
      </section>
      <section className="card pad stack" style={{ gap: 12 }}>
        <h2 className="h2">Implementation agents</h2>
        <div className="well scroll-x" style={{ padding: 6 }}>
          <table className="tbl" style={{ minWidth: 640 }}>
            <thead><tr><th>Agent</th><th>Provider-defined max</th><th>Your context limit</th><th>Your max output</th></tr></thead>
            <tbody>
              {impl.map((agent) => {
                const cli = snap.clis.find((c) => c.kind === agent.provider);
                const h = cli ? healths[cli.id] : undefined;
                const over = h?.contextMax.value && agent.contextTokens > h.contextMax.value;
                return (
                  <tr key={agent.id}>
                    <td style={{ fontWeight: 600 }}>{agent.name}<div className="sub" style={{ fontWeight: 400 }}>{agent.model}</div></td>
                    <td><span className="row" style={{ gap: 8 }}><Icon name="lock" size="sm" className="mut" />{h?.contextMax.value ? tokens(h.contextMax.value) : "Unknown"}<ProvenanceChip value={h?.contextMax.provenance ?? "unavailable"} /></span>{h && h.state !== "connected" && <div className="sub">{cli?.name}: {connectionMeta[h.state].label}</div>}</td>
                    <td><input className={`input ${over ? "bad" : ""}`} style={{ width: 120 }} defaultValue={agent.contextTokens} aria-label={`${agent.name} context limit`} onBlur={async (e) => { const v = Number(e.target.value.replace(/\D/g, "")); if (v && v !== agent.contextTokens) setAgents(await window.api.saveAgent({ ...agent, contextTokens: v })); }} />{over && <div className="sub err">Above the reported maximum</div>}</td>
                    <td><input className="input" style={{ width: 120 }} defaultValue={agent.maxOutputTokens} aria-label={`${agent.name} max output`} onBlur={async (e) => { const v = Number(e.target.value.replace(/\D/g, "")); if (v && v !== agent.maxOutputTokens) setAgents(await window.api.saveAgent({ ...agent, maxOutputTokens: v })); }} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <span className="hint">QA, Assessment, Elevation, workflow roles and Codex / Claude Code implementation agents manage their own context inside their CLI.</span>
      </section>
    </div>
  );
}

function Safety() {
  const { snap } = useApp();
  const w = snap.settings.workflow;
  const patch = useSettingsPatch();
  const [draft, setDraft] = useState("");
  const paths = snap.settings.safety.protectedPaths;
  return (
    <div className="stack" style={{ gap: 20 }}>
      {!w.toolGuard && (
        <div className="banner fade-in" role="status"><Icon name="lock" className="info" /><div className="grow"><div style={{ fontWeight: 600 }}>Protected-path checks stay on</div><div className="sub">Turning off the optional tool guard does not allow protected paths, interpreters or arbitrary shell scripts. Cline and OpenCode still use restricted tools to enforce this boundary. Loop-limit settings are independent.</div></div></div>
      )}
      <section className="card pad">
        <h2 className="h2" style={{ marginBottom: 4 }}>Worker tool guard</h2>
        <SetRow title="Restrict the implementation worker" desc="Native edits only inside the task's approved paths; shell limited to the task's QA command, lint/typecheck, exact-file Prettier and read-only Git; interpreters and redirection stop the attempt" support="engine">
          <Toggle on={w.toolGuard} onChange={(v) => patch("workflow", { toolGuard: v })} label="Tool guard" danger={!w.toolGuard} />
        </SetRow>
      </section>
      <section className="card pad stack" style={{ gap: 12 }}>
        <h2 className="h2" style={{ marginBottom: 4 }}>Unattended mode</h2>
        <SetRow title="Run without supervision" desc="Locks the tool guard on, continues automatically between tasks, and enforces the limits below. A limit stops the run at the next safe point (never mid-task), so the work in progress may go slightly past it. Every run writes run-report.md in the project's state folder." support="engine">
          <Toggle on={w.unattended === true} onChange={(v) => patch("workflow", { unattended: v })} label="Unattended mode" />
        </SetRow>
        {w.unattended && (
          <div className="grid-4">
            {([
              ["maxTasks", "Stop after approved tasks", "0 = no limit"],
              ["maxHours", "Stop after hours", "0 = no limit"],
              ["maxCorrections", "Corrections per task", "then stop for you (at least 1)"],
              ["maxElevations", "Automatic Elevations per run", "0 = no limit"],
              ["maxMillionTokens", "Token budget per run (millions)", "0 = no limit"],
              ["maxCostUsd", "Spend budget per run (USD)", "Claude Code and OpenCode report cost; 0 = no limit"],
              ["maxMillionTokensDay", "Token budget per day (millions)", "this project, all runs today"],
              ["maxCostUsdDay", "Spend budget per day (USD)", "this project, all runs today"],
            ] as const).map(([key, label, hint]) => {
              const limits = { ...DEFAULT_SETTINGS.workflow.unattendedLimits, ...w.unattendedLimits };
              return (
                <label className="field" key={key}><span>{label}</span>
                  <input className="input mono" inputMode="decimal" defaultValue={limits[key] ?? 0} aria-label={label}
                    onBlur={(e) => { const v = Number(e.target.value); if (Number.isFinite(v) && v >= (key === "maxCorrections" ? 1 : 0) && v !== limits[key]) patch("workflow", { unattendedLimits: { ...limits, [key]: DECIMAL_LIMITS.has(key) ? v : Math.floor(v) } }); else e.target.value = String(limits[key] ?? 0); }} />
                  <span className="hint">{hint}</span>
                </label>
              );
            })}
          </div>
        )}
      </section>
      <SupervisorCard />
      <StopAllCard />
      <section className="card pad stack" style={{ gap: 12 }}>
        <h2 className="h2">Always enforced by the engine</h2>
        <ul className="list">
          {[
            "Each task declares its allowed paths; edits elsewhere fail the scope check",
            "Cline never commits; QA makes exactly one commit per approved task",
            "A non-PASS result must leave HEAD unchanged",
            "Failed work is left in place for inspection, never reset or committed automatically",
            "A dirty baseline after a crash blocks automatic restart",
            "Usage-limit failures wait for Resume instead of counting as QA failures",
          ].map((t) => <li key={t}><St kind="done" /><span>{t}</span></li>)}
        </ul>
      </section>
      <section className="card pad stack" style={{ gap: 12 }}>
        <div className="row" style={{ gap: 8 }}><h2 className="h2">Protected paths</h2><Support kind="engine" /></div>
        <span className="sub">Block agent tool reads and writes on the next engine start. Use project-relative paths, absolute paths, or * and ** patterns. Agent Dock's app, settings, state and engine folders are always protected. Project check scripts still run as trusted code.</span>
        <div className="row wrap" style={{ gap: 8 }}>
          {paths.map((p) => <span className="chip raised mono" key={p}>{p}<button className="x" aria-label={`Remove ${p}`} onClick={() => patch("safety", { protectedPaths: paths.filter((x) => x !== p) })}><Icon name="close" size="sm" /></button></span>)}
        </div>
        <div className="row" style={{ maxWidth: 520 }}>
          <input className="input mono" placeholder="e.g. migrations/" value={draft} onChange={(e) => setDraft(e.target.value)} />
          <button className="btn" disabled={!draft.trim()} onClick={() => { patch("safety", { protectedPaths: [...paths, draft.trim()] }); setDraft(""); }}>Add</button>
        </div>
      </section>
      <section className="card pad">
        <h2 className="h2" style={{ marginBottom: 4 }}>Processes</h2>
        <SetRow title="Timeout handling" desc="Each Cline attempt is bounded by the Implementation agent's timeout" support="engine"><span className="chip mut">Per agent</span></SetRow>
        <SetRow title="Process termination" desc="Stop now terminates the engine's process tree (taskkill /T /F); the engine recovers from saved state" support="app"><span className="chip mut">On request</span></SetRow>
        <SetRow title="Crash recovery" desc="Interrupted orchestrator operations are saved and replayed with identical inputs on Resume" support="engine"><span className="chip mut">Fixed by engine</span></SetRow>
      </section>
    </div>
  );
}

/** Supervisor v1 (monitors, what it may do) and the remote notification channels. */
function SupervisorCard() {
  const { snap, toast, refresh } = useApp();
  const patch = useSettingsPatch();
  const sv = { ...DEFAULT_SETTINGS.workflow.supervisor!, ...snap.settings.workflow.supervisor };
  const g = snap.settings.general;
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const saveChannel = async (kind: "webhook" | "discord", url: string | null) => {
    try { await window.api.setNotifyChannel(kind, url); await refresh(); setDrafts((d) => ({ ...d, [kind]: "" })); toast("success", url ? "Saved (encrypted)" : "Removed"); }
    catch (error) { toast("error", (error as Error).message); }
  };
  return (
    <section className="card pad stack" style={{ gap: 12 }}>
      <h2 className="h2" style={{ marginBottom: 4 }}>Supervisor</h2>
      <SetRow title="What the Supervisor may do" desc="It watches every run for repeated failures, stalls, token burn, guard refusals, plan drift and scope creep. Pause or Stop act only on serious signs, at the next safe point. It never edits code, commits, approves QA or loosens a guard, limit or path." support="engine">
        <select className="sel" value={sv.mode} aria-label="Supervisor mode" onChange={(e) => void patch("workflow", { supervisor: { ...sv, mode: e.target.value as typeof sv.mode } })}>
          <option value="off">Off</option>
          <option value="alert">Alert only</option>
          <option value="pause">Alert and pause</option>
          <option value="stop">Alert and stop</option>
        </select>
      </SetRow>
      {sv.mode !== "off" && (
        <div className="grid-4">
          {([
            ["repeatFailures", "Same QA failure in a row", "alert (and act) after this many"],
            ["stallMinutes", "Stall after minutes", "no engine activity; alert only"],
            ["refusals", "Guard refusals in 10 min", "alert; act at twice this"],
            ["millionTokensPerTask", "Tokens per task (millions)", "alert; act at twice this; 0 = off"],
            ["planDrift", "Approved tasks without plan progress", "IMPLEMENTATION_PLAN.md; alert only"],
            ["scopePaths", "Allowed paths per task", "or broad paths like src/**; alert only"],
            ["digestHours", "Digest every hours", "0 = only at the end of a run"],
          ] as const).map(([key, label, hint]) => (
            <label className="field" key={key}><span>{label}</span>
              <input className="input mono" inputMode="decimal" defaultValue={sv[key]} aria-label={label}
                onBlur={(e) => { const v = Number(e.target.value); if (Number.isFinite(v) && v >= 0 && v !== sv[key]) void patch("workflow", { supervisor: { ...sv, [key]: ["stallMinutes", "millionTokensPerTask", "digestHours"].includes(key) ? v : Math.floor(v) } }); else e.target.value = String(sv[key]); }} />
              <span className="hint">{hint}</span>
            </label>
          ))}
        </div>
      )}
      <SetRow title="Desktop" desc="Supervisor alerts follow Settings › General error notifications; digests follow information notifications." support="app">
        <Toggle on={g.notifyDigests !== false} onChange={(v) => void patch("general", { notifyDigests: v })} label="Send digests" />
      </SetRow>
      {(["webhook", "discord"] as const).map((kind) => (
        <SetRow key={kind} title={kind === "webhook" ? "Webhook" : "Discord"}
          desc={snap.notifyChannels[kind]
            ? "Saved (encrypted). The engine sends alerts, run limits, attention, blocked runs and digests here itself, even with the app closed."
            : kind === "webhook" ? "POSTs JSON {source, project, type, title, message, at}. https only." : "A Discord channel webhook URL (Channel settings › Integrations › Webhooks)."}
          support="engine">
          {snap.notifyChannels[kind] ? (
            <div className="row" style={{ gap: 8 }}>
              <button className="btn sm" onClick={() => void window.api.testNotifyChannel(kind).then(() => toast("success", "Test sent"), (error) => toast("error", (error as Error).message))}>Send test</button>
              <button className="btn sm danger" onClick={() => void saveChannel(kind, null)}>Remove</button>
            </div>
          ) : (
            <div className="row" style={{ gap: 8 }}>
              <input className="input mono" type="password" placeholder="https://…" value={drafts[kind] ?? ""} aria-label={`${kind} URL`} onChange={(e) => setDrafts((d) => ({ ...d, [kind]: e.target.value }))} />
              <button className="btn sm" disabled={!drafts[kind]?.trim()} onClick={() => void saveChannel(kind, drafts[kind].trim())}>Save</button>
            </div>
          )}
        </SetRow>
      ))}
    </section>
  );
}

/** Stop-all (app, tray, terminal launcher) and the per-project action log check. */
function StopAllCard() {
  const { snap, toast } = useApp();
  const [confirmNow, setConfirmNow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [logs, setLogs] = useState<Awaited<ReturnType<typeof window.api.verifyActionLogs>> | null>(null);
  const stop = async (now: boolean) => {
    setBusy(true);
    try {
      const results = await window.api.stopAll(now);
      toast("success", results.length ? results.map((r) => `${r.project}: ${r.result}`).join(" · ") : "No project was running.");
    } catch (error) { toast("error", (error as Error).message); }
    finally { setBusy(false); setConfirmNow(false); }
  };
  return (
    <section className="card pad stack" style={{ gap: 12 }}>
      <h2 className="h2" style={{ marginBottom: 4 }}>Stop all and action log</h2>
      <SetRow title="Stop every running project" desc="At the next safe point, or at once (kills engines and their workers mid-task; unfinished work stays in the working tree). Also in the tray menu." support="app">
        <div className="row" style={{ gap: 8 }}>
          <button className="btn sm" disabled={busy} onClick={() => void stop(false)}>Stop all</button>
          <button className="btn sm danger" disabled={busy} onClick={() => setConfirmNow(true)}>Stop all now…</button>
        </div>
      </SetRow>
      <SetRow title="From a terminal" desc={snap.paths.stopAll ? <span>Works without the app; add <span className="mono">--now</span> to stop at once or <span className="mono">--project "Name"</span> for one project: <span className="mono">{snap.paths.stopAll}</span></span> : "The launcher could not be written to the config folder."} support="app">
        {snap.paths.stopAll ? <button className="btn sm" onClick={() => void navigator.clipboard.writeText(`"${snap.paths.stopAll}"`).then(() => toast("success", "Command copied"))}>Copy command</button> : null}
      </SetRow>
      <SetRow title="Action log" desc="Every activity event and control request (with who asked: app, dashboard, terminal or a run limit), chained by SHA-256 in action-log.ndjson in each project's state folder. Clearing activity history never touches it; an edited or deleted entry breaks the chain." support="engine">
        <button className="btn sm" onClick={() => void window.api.verifyActionLogs().then(setLogs, (error) => toast("error", (error as Error).message))}>Verify logs</button>
      </SetRow>
      {logs && (
        <ul className="list">
          {logs.length ? logs.map((l) => (
            <li key={l.project}><St kind={l.ok ? "done" : "blocked"} /><span>{l.project}: {l.ok ? `verified, ${l.entries} entries${l.lastAt ? `, last ${new Date(l.lastAt).toLocaleString()}` : ""}` : `NOT verified${l.brokenAt ? ` at entry ${l.brokenAt}` : ""}: ${l.reason}`}</span></li>
          )) : <li><span>No projects.</span></li>}
        </ul>
      )}
      {confirmNow && (
        <Modal label="Stop all now" onClose={() => setConfirmNow(false)}>
          <div>
            <h2 className="h2">Stop every running project now?</h2>
            <p className="sub" style={{ margin: "6px 0 0" }}>Engines and their workers are killed mid-task. Unfinished work stays in the working tree for you to inspect; nothing is committed or reset.</p>
          </div>
          <div className="row" style={{ gap: 10 }}>
            <span className="grow" />
            <button className="btn ghost" onClick={() => setConfirmNow(false)}>Cancel</button>
            <button className="btn primary" disabled={busy} onClick={() => void stop(true)}>Stop all now</button>
          </div>
        </Modal>
      )}
    </section>
  );
}

/** Engine guardrails switch (Settings › Advanced and first setup). Turning it off asks for confirmation. */
export function EngineGuardrails() {
  const { snap } = useApp();
  const patch = useSettingsPatch();
  const [confirm, setConfirm] = useState(false);
  const on = snap.settings.advanced.engineGuardrails !== false;
  return (
    <>
      <SetRow
        title="Engine guardrails"
        desc={on ? "On: each role may use its own CLI; models must come from that role's CLI, Fast only where the CLI reports it, and the engine's loop limits are fixed." : "Off: each role may use its own CLI and any model, effort or speed, and the loop limits in Workflow rules and Context limits are editable. Mismatches are shown as warnings and the run starts anyway."}
        support="app"
      >
        <Toggle on={on} onChange={(v) => (v ? patch("advanced", { engineGuardrails: true }) : setConfirm(true))} label="Engine guardrails" />
      </SetRow>
      {confirm && (
        <Modal label="Turn off engine guardrails" onClose={() => setConfirm(false)}>
          <div>
            <h2 className="h2">Turn off engine guardrails?</h2>
            <p className="sub" style={{ margin: "6px 0 0" }}>For users who know what each choice does. The engine's safety checks stay on either way: only QA commits, scope and HEAD are verified, unsafe states stop for you.</p>
          </div>
          <ul className="sub" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.6 }}>
            <li>QA, Assessment and Elevation may run on different CLIs; the engine routes each role to its own CLI.</li>
            <li>Any model id is passed as typed, even one the CLI doesn't list or that belongs to another CLI. A wrong id fails that role's call.</li>
            <li>Fast is sent even when the model or account doesn't report it.</li>
            <li>Loop limits become editable: elevation threshold, correction limit, Resolver strategies, task sizing and default context.</li>
            <li>Launch checks become warnings instead of stopping the start.</li>
          </ul>
          <div className="row" style={{ gap: 10 }}>
            <span className="grow" />
            <button className="btn ghost" onClick={() => setConfirm(false)}>Keep on</button>
            <button className="btn primary" onClick={() => { void patch("advanced", { engineGuardrails: false }); setConfirm(false); }}>Turn off</button>
          </div>
        </Modal>
      )}
    </>
  );
}

function Advanced() {
  const { snap, saveSettings, toast } = useApp();
  const ad = snap.settings.advanced;
  const patch = useSettingsPatch();
  const [resetOpen, setResetOpen] = useState(false);
  return (
    <div className="stack" style={{ gap: 20 }}>
      <section className="card pad">
        <h2 className="h2" style={{ marginBottom: 4 }}>Engine</h2>
        <EngineGuardrails />
        <SetRow title="Engine folder" desc={<span className="mono">{snap.engine.dir}</span>} support="app"><button className="btn sm" onClick={() => window.api.openPath(snap.engine.dir)}>Open</button></SetRow>
        <SetRow title="Node runtime" desc="Runs engine/src/cli.mjs. System Node is used when found on PATH; otherwise Electron's bundled runtime" support="app">
          <select className="sel" value={ad.nodeRuntime} onChange={(e) => patch("advanced", { nodeRuntime: e.target.value as typeof ad.nodeRuntime })} aria-label="Node runtime"><option value="system">System Node (PATH)</option><option value="electron">Electron's bundled Node</option></select>
        </SetRow>
        <SetRow title="llama.cpp launcher" desc="Script the engine runs to start llama.cpp when it is unreachable (and for router-mode model lists). Empty: start llama.cpp yourself." support="engine">
          <input
            className="input mono"
            style={{ width: 300 }}
            defaultValue={ad.llamaCppLauncher}
            placeholder="C:\llama\start-server.cmd"
            onBlur={(e) => e.target.value.trim() !== ad.llamaCppLauncher && patch("advanced", { llamaCppLauncher: e.target.value.trim() })}
            aria-label="llama.cpp launcher"
          />
        </SetRow>
        <SetRow title="Debug logging" support="saved"><Toggle on={ad.debug} onChange={(v) => patch("advanced", { debug: v })} label="Debug logging" /></SetRow>
      </section>
      <section className="card pad">
        <h2 className="h2" style={{ marginBottom: 4 }}>Storage and configuration</h2>
        <SetRow title="Configuration folder" desc={<span className="mono">{snap.paths.config}</span>} support="app"><button className="btn sm" onClick={() => window.api.openPath(snap.paths.config)}>Open</button></SetRow>
        <SetRow title="Engine state for app-managed projects" desc={<span className="mono">{snap.paths.projectState}</span>} support="app"><button className="btn sm" onClick={() => window.api.openPath(snap.paths.projectState)}>Open</button></SetRow>
        <SetRow title="Backup" desc="Copy the configuration folder to back up projects, agents, connections and settings. Credentials are encrypted for this Windows account only." support="app"><span className="chip mut">Manual</span></SetRow>
        <SetRow title={<span className="err">Reset all settings</span>} desc="Projects, agents, connections and credentials are kept" support="app"><button className="btn sm danger" onClick={() => setResetOpen(true)}>Reset…</button></SetRow>
      </section>
      {resetOpen && (
        <Modal label="Reset settings" onClose={() => setResetOpen(false)}>
          <h2 className="h2">Reset all settings?</h2>
          <p className="sub" style={{ margin: 0 }}>General, workflow, attention, context, safety and advanced settings return to defaults. Projects, agents, connections, credentials and engine history are kept.</p>
          <div className="row"><span className="grow" /><button className="btn ghost" onClick={() => setResetOpen(false)}>Cancel</button>
            <button className="btn danger-fill" onClick={async () => { await saveSettings({ ...DEFAULT_SETTINGS, activeProjectId: snap.settings.activeProjectId, onboardingComplete: true, skills: snap.settings.skills }); setResetOpen(false); toast("success", "Settings reset to defaults"); }}>Reset settings</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

let pendingSection: Section | null = null;
/** Open a specific section the next time the Settings page mounts (call before go("settings")). */
export const openSettingsSection = (section: Section) => {
  pendingSection = section;
};

export function SettingsPage() {
  const [section, setSection] = useState<Section>(() => {
    const initial = pendingSection ?? "workflow";
    pendingSection = null;
    return initial;
  });
  return (
    <>
      <div><h1 className="h1">Settings</h1><div className="sub">Changes save immediately. Labels show whether the engine enforces a setting, the app applies it, or it is saved for later.</div></div>
      <div className="setgrid">
        <nav className="secnav" aria-label="Settings sections">
          {SECTIONS.map((s) => <button key={s.value} className={`sec ${section === s.value ? "on" : ""}`} aria-current={section === s.value ? "page" : undefined} onClick={() => setSection(s.value)}>{s.label}</button>)}
        </nav>
        <div className="fade-in" key={section} style={{ minWidth: 0 }}>
          {section === "general" && <General />}
          {section === "skills" && <Skills />}
          {section === "workflow" && <Workflow />}
          {section === "context" && <Context />}
          {section === "safety" && <Safety />}
          {section === "updates" && <Updates />}
          {section === "advanced" && <Advanced />}
        </div>
      </div>
    </>
  );
}
