import { useEffect, useState } from "react";
import type { Agent, Settings, SkillInfo } from "@shared/types";
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

function Skills() {
  const { snap, setAgents, saveSettings, toast } = useApp();
  const [skills, setSkills] = useState<SkillInfo[] | null>(null);
  const [selId, setSelId] = useState<string | null>(null);
  useEffect(() => {
    void window.api.skills().then((s) => {
      setSkills(s);
      setSelId(s[0]?.id ?? null);
    });
  }, []);
  if (!skills) return <div className="skel" style={{ width: "50%" }} />;
  const sel = skills.find((s) => s.id === selId) ?? null;
  const enabled = (s: SkillInfo) => snap.settings.skills.enabled[s.id] ?? true;
  const assigned = (s: SkillInfo) => snap.agents.filter((a) => a.skills.includes(s.name));
  const toggleAgent = async (agent: Agent, skill: SkillInfo) => {
    const has = agent.skills.includes(skill.name);
    setAgents(await window.api.saveAgent({ ...agent, skills: has ? agent.skills.filter((x) => x !== skill.name) : [...agent.skills, skill.name] }));
  };
  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="banner"><Icon name="warn" className="info" /><span>The engine always injects its bundled <span className="mono">bounded-task-handoff</span> skill into Assessment, QA and Cline handoffs. Other skills and assignments are saved here for when the engine accepts additional skills.</span></div>
      <div className="row wrap" style={{ gap: 12 }}>
        <span className="sub grow">{skills.length} skills · {skills.filter((s) => s.source === "engine").length} bundled with the engine</span>
        <button className="btn" onClick={async () => setSkills(await window.api.importSkillFolder())}><Icon name="download" size="sm" />Import from folder</button>
      </div>
      {skills.length === 0 ? <Empty title="No skills found" icon="settings" /> : (
        <section className="well scroll-x" style={{ padding: 6 }}>
          <table className="tbl" style={{ minWidth: 720 }}>
            <thead><tr><th>Skill</th><th>Source</th><th>Assigned to</th><th>Compatibility</th><th>Enabled</th></tr></thead>
            <tbody>
              {skills.map((s) => (
                <tr key={s.id} className={`click ${s.id === selId ? "sel" : ""}`} onClick={() => setSelId(s.id)}>
                  <td><button className="rowbtn"><span className="name" style={{ fontWeight: 600 }}>{s.name}</span><span className="sub ellipsis" style={{ maxWidth: 300 }}>{s.description}</span></button></td>
                  <td><span className={`chip ${s.source === "engine" ? "info" : "lav"}`}>{s.source === "engine" ? "Engine" : "Imported"}</span></td>
                  <td className="sub">{assigned(s).map((a) => a.name).join(", ") || "None"}</td>
                  <td><span className={`row ${s.warnings.length ? "warn" : "ok"}`} style={{ gap: 6, fontSize: 12 }}><span className="dot" />{s.warnings.length ? `${s.warnings.length} warning(s)` : "Compatible"}</span></td>
                  <td onClick={(e) => e.stopPropagation()}>{s.source === "engine" ? <span className="lock"><Icon name="lock" size="sm" />Required</span> : <Toggle on={enabled(s)} onChange={(v) => saveSettings({ ...snap.settings, skills: { ...snap.settings.skills, enabled: { ...snap.settings.skills.enabled, [s.id]: v } } })} label={`Enable ${s.name}`} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
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
        <SetRow title="Automatic continuation" desc="Start the next task as soon as one is approved. Off: the app requests Pause After Task whenever QA passes." support="app"><Toggle on={w.autoContinue} onChange={(v) => patch("workflow", { autoContinue: v })} label="Automatic continuation" /></SetRow>
        <SetRow title="Automatic elevation" desc="One short Elevation reassessment on a manual-review case. Its advice still goes through independent QA." support="engine"><Toggle on={w.automaticElevation} onChange={(v) => patch("workflow", { automaticElevation: v })} label="Automatic elevation" /></SetRow>
        <SetRow title="QA failure handling" desc="Actionable failures return a bounded correction to Cline, with no numeric retry limit" support="engine"><span className="chip mut">Fixed by engine</span></SetRow>
        <SetRow title="Strategy reassessment" desc="On attempts 5, 10, 15… QA must issue a materially revised correction strategy" support="engine"><span className="chip mut">Every 5 attempts</span></SetRow>
        <SetRow title="Blocked cases" desc="The read-only Resolver runs once all workers are idle; at most three distinct recovery strategies per task" support="engine"><span className="chip mut">Fixed by engine</span></SetRow>
        <SetRow title="After the app restarts" desc="When a project was mid-task and its engine is no longer running" support="app">
          <select className="sel" value={w.resumeAfterRestart} onChange={(e) => patch("workflow", { resumeAfterRestart: e.target.value as typeof w.resumeAfterRestart })} aria-label="Resume behaviour">
            <option value="ask">Ask me</option><option value="auto">Resume automatically</option><option value="paused">Stay stopped</option>
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
  const impl = snap.agents.filter((x) => x.role === "implementation");
  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="row wrap sub" style={{ gap: 18 }}>
        <span className="row" style={{ gap: 6 }}><ProvenanceChip value="reported" />Defined by the provider or hardware, read-only</span>
        <span className="row" style={{ gap: 6 }}><span className="chip lav" style={{ height: 18, fontSize: 10.5 }}>Yours</span>Limit you configure; must not exceed the provider's</span>
      </div>
      <section className="card pad">
        <h2 className="h2" style={{ marginBottom: 4 }}>Defaults</h2>
        <SetRow title="Engine default context window" desc="Used for new Implementation agents" support="engine"><span className="mono">{snap.engine.defaults.contextTokens.toLocaleString()}</span></SetRow>
        <SetRow title="Engine default maximum output" support="engine"><span className="mono">{snap.engine.defaults.maxOutputTokens.toLocaleString()}</span></SetRow>
        <SetRow title="Context warning threshold" desc="Warn when a configured context reaches this share of the model's reported maximum" support="app">
          <input type="range" min={50} max={95} step={5} value={snap.settings.context.warnThresholdPercent} onChange={(e) => patch("context", { warnThresholdPercent: Number(e.target.value) })} aria-label="Warning threshold" style={{ accentColor: "var(--a)", width: 200 }} />
          <span className="mono" style={{ width: 40 }}>{snap.settings.context.warnThresholdPercent}%</span>
        </SetRow>
        <SetRow title="Compaction" desc="Cline compacts its own history; compaction events are counted on the Token tab" support="engine"><span className="chip mut">Managed by Cline</span></SetRow>
        <SetRow title="Large files" desc="Assessment sizes tasks for the local worker: one file per task where possible, new files under ~200 lines, at most three files to read" support="engine"><span className="chip mut">Fixed by engine</span></SetRow>
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
        <span className="hint">QA, Assessment and Elevation context is managed inside the orchestrator CLI and is not configurable by the engine.</span>
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
        <div className="banner warnb fade-in" role="alert"><Icon name="warn" className="warn" /><div className="grow"><div style={{ fontWeight: 600 }}>This configuration can cause unsafe repository changes</div><div className="sub">With the tool guard off, Cline runs with its normal tools: it can run interpreters, redirect output and write helper files. Node scope/HEAD checks and QA still gate every accepted change.</div></div></div>
      )}
      <section className="card pad">
        <h2 className="h2" style={{ marginBottom: 4 }}>Worker tool guard</h2>
        <SetRow title="Restrict the implementation worker" desc="Native edits only inside the task's approved paths; shell limited to the task's QA command, lint/typecheck, exact-file Prettier and read-only Git; interpreters and redirection stop the attempt" support="engine">
          <Toggle on={w.toolGuard} onChange={(v) => patch("workflow", { toolGuard: v })} label="Tool guard" danger={!w.toolGuard} />
        </SetRow>
      </section>
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
        <div className="row" style={{ gap: 8 }}><h2 className="h2">Protected paths</h2><Support kind="saved" /></div>
        <span className="sub">Extra paths to keep out of every task. Saved for engine support; today, scope is enforced through each task's allowed paths.</span>
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
        desc={on ? "On: QA, Assessment and Elevation share one orchestrator CLI, models must come from that CLI, and Fast only where the CLI reports it." : "Off: each role may use its own CLI (Codex or Claude Code) and any model, effort or speed. Mismatches are shown as warnings and the run starts anyway."}
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
