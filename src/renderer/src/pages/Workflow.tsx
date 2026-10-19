import { useEffect, useState } from "react";
import { STAGES, stageLabel } from "../lib/stages";
import type { RoleDraft } from "@shared/api";
import type { Agent, RoleStage, WorkflowRole } from "@shared/types";
import { cleanError, useApp } from "../store";
import { roleLabel, uid } from "../lib/format";
import { agentForRoleClient } from "../lib/agents";
import { effortLabel } from "../lib/models";
import { Icon } from "../components/Icon";
import { Empty, Modal, Support, Toggle } from "../components/ui";
import { SECOND_OPINION_ROLE_ID, SECOND_OPINION_TEMPLATE } from "@shared/workflow-templates";


const TEMPLATES: (RoleDraft & { blurb: string })[] = [
  SECOND_OPINION_TEMPLATE,
  {
    blurb: "Plans the change before the worker starts",
    name: "Planner", description: "Turns the task into a short step list for the implementer", stage: "before-implementation", gate: false, enabled: true,
    instructions: "Read the task and the files it names. Give the implementer a numbered plan of at most five concrete steps: which function to add or change, in which file, and what the test should assert. Point out any existing helper the change should reuse. Do not restate the task.",
  },
  {
    blurb: "Reviews each attempt and can send it back",
    name: "Code reviewer", description: "Checks the diff for bugs and unhandled cases before QA", stage: "before-qa", gate: true, enabled: true,
    instructions: "Review only the diff against the task's acceptance criteria. Return changes-needed for a real defect: wrong logic, an unhandled error or edge case the criteria require, or a broken caller. Ignore style and naming unless they hide a bug. Each finding names the file and line and says what is wrong.",
  },
  {
    blurb: "Summarises each accepted task",
    name: "Release notes", description: "Writes a one-paragraph change note for every committed task", stage: "after-pass", gate: false, enabled: true,
    instructions: "Write one short paragraph for a changelog: what changed for a user or developer, in plain language, past tense. Mention new commands, options or behaviour. No file lists.",
  },
];

const emptyDraft = (): RoleDraft => ({ name: "", description: "", stage: "before-qa", gate: false, enabled: true, instructions: "" });
const toDraft = (r: WorkflowRole): RoleDraft => ({ id: r.id, name: r.name, description: r.description, stage: r.stage, gate: r.gate, fix: r.fix === true, enabled: r.enabled, instructions: r.instructions });

/** Agents that run a role: custom-role agents whose customRole is the role's id or name. */
export function agentsForRole(role: Pick<WorkflowRole, "id" | "name">, agents: Agent[]) {
  const name = role.name.trim().toLowerCase();
  return agents.filter((a) => a.role === "custom" && (a.customRole === role.id || (name && a.customRole?.trim().toLowerCase() === name)));
}

function Pipeline({ onPick, selected }: { onPick: (id: string) => void; selected: string | null }) {
  const { snap, activeProject } = useApp();
  const builtIn = (role: "assessment" | "implementation" | "qa") => agentForRoleClient(role, activeProject, snap.agents);
  const at = (stage: RoleStage) => snap.roles.filter((r) => r.stage === stage);
  const Step = ({ role, note }: { role: "assessment" | "implementation" | "qa"; note: string }) => {
    const agent = builtIn(role);
    return (
      <div className="flow-step">
        <span className="eyebrow">{roleLabel[role]}</span>
        <b>{agent?.name ?? "Not assigned"}</b>
        <span className="hint">{note}</span>
      </div>
    );
  };
  const Custom = ({ stage }: { stage: RoleStage }) => {
    const roles = at(stage);
    if (!roles.length) return <span className="flow-arrow" aria-hidden>→</span>;
    return (
      <>
        <span className="flow-arrow" aria-hidden>→</span>
        {roles.map((r) => {
          const runner = agentsForRole(r, snap.agents).find((a) => a.enabled);
          return (
            <button key={r.id} className={`flow-step custom ${selected === r.id ? "on" : ""} ${r.enabled && runner ? "" : "off"}`} onClick={() => onPick(r.id)} title={stageLabel(r.stage)}>
              <span className="eyebrow">{r.fix ? "Fixer" : r.gate ? "Gate" : "Role"}</span>
              <b>{r.name}</b>
              <span className="hint">{!r.enabled ? "Disabled" : runner ? runner.name : r.id === SECOND_OPINION_ROLE_ID ? "Assign an agent to start" : "No agent: skipped"}</span>
            </button>
          );
        })}
        <span className="flow-arrow" aria-hidden>→</span>
      </>
    );
  };
  return (
    <section className="card pad stack" style={{ gap: 12 }} aria-label="Workflow pipeline">
      <div className="row wrap" style={{ gap: 8 }}>
        <h2 className="h2">One task through the loop</h2>
        <span className="sub">{activeProject ? `agents as resolved for ${activeProject.name}` : "default agents"}</span>
      </div>
      <div className="flow">
        <Step role="assessment" note="Picks one bounded task" />
        <Custom stage="before-implementation" />
        <Step role="implementation" note="Changes only the task's paths" />
        <Custom stage="before-qa" />
        <Step role="qa" note="Verifies and makes the commit" />
        <Custom stage="after-pass" />
        <div className="flow-step end"><span className="eyebrow">Next</span><b>Next task</b><span className="hint">Back to Assessment</span></div>
      </div>
      <span className="hint">On a failed check, Assessment writes a correction and the task goes back to Implementation. Elevation and the Resolver step in when corrections stall or a task is blocked. Your roles are read-only: they never edit files or commit.</span>
    </section>
  );
}

function RoleEditor({ role, draft, setDraft, onSaved, onDelete }: { role: WorkflowRole | null; draft: RoleDraft; setDraft: (d: RoleDraft) => void; onSaved: (roles: WorkflowRole[], id: string) => void; onDelete: () => void }) {
  const { snap, setAgents, toast, go, activeProject } = useApp();
  const [saving, setSaving] = useState(false);
  const dirty = !role || JSON.stringify(draft) !== JSON.stringify(toDraft(role));
  const set = <K extends keyof RoleDraft>(k: K, v: RoleDraft[K]) => setDraft({ ...draft, [k]: v });
  const runners = role ? agentsForRole(role, snap.agents) : [];
  const runner = runners.find((a) => a.enabled) ?? runners[0] ?? null;
  const customAgents = snap.agents.filter((a) => a.role === "custom");
  const cliName = (a: Agent) => snap.clis.find((c) => c.id === a.cliId)?.name ?? "No CLI";
  const cloudCli = (a: Agent) => ["codex", "claude"].includes(snap.clis.find((c) => c.id === a.cliId)?.kind ?? "");

  const save = async () => {
    setSaving(true);
    try {
      const roles = await window.api.saveRole(draft);
      const saved = roles.find((r) => (draft.id ? r.id === draft.id : r.name === draft.name.trim())) ?? roles[0];
      onSaved(roles, saved.id);
      toast("success", `${draft.name.trim()} saved`);
    } catch (e) {
      toast("error", cleanError(e));
    } finally {
      setSaving(false);
    }
  };
  /** Point one agent at this role; other agents on it are unassigned so the role has a single runner. */
  const assign = async (agentId: string) => {
    if (!role) return;
    let list = snap.agents;
    for (const a of runners.filter((x) => x.id !== agentId)) list = await window.api.saveAgent({ ...a, customRole: "" });
    const chosen = list.find((a) => a.id === agentId);
    if (chosen) list = await window.api.saveAgent({ ...chosen, customRole: role.id, enabled: true });
    setAgents(list);
  };
  const createAgent = async () => {
    if (!role) return;
    const qa = agentForRoleClient("qa", activeProject, snap.agents);
    const qaKind = snap.clis.find(c => c.id === qa?.cliId)?.kind;
    const preferred = role.id === SECOND_OPINION_ROLE_ID && qaKind === "codex" ? "claude" : "codex";
    const cli = snap.clis.find((c) => c.kind === preferred) ?? snap.clis.find((c) => c.kind === "claude");
    if (!cli) return toast("error", "Add a Codex CLI or Claude Code connection first (CLIs).");
    const agent: Agent = {
      id: uid("agent"), name: `${role.name} agent`, role: "custom", customRole: role.id, cliId: cli.id, model: "", reasoning: "medium", fast: false,
      contextTokens: 0, maxOutputTokens: snap.engine.defaults.maxOutputTokens, timeoutSeconds: snap.engine.defaults.timeoutSeconds, instructions: "", skills: [], enabled: true,
    };
    for (const a of runners) await window.api.saveAgent({ ...a, customRole: "" });
    setAgents(await window.api.saveAgent(agent));
    toast("success", `${agent.name} created on ${cli.name}. Pick its model in Agents.`);
  };

  return (
    <section className="card pad stack fade-in" style={{ gap: 18 }} aria-label="Role editor">
      <div className="row wrap" style={{ gap: 12 }}>
        <div className="grow">
          <div className="row"><h2 className="h1">{role ? role.name : draft.name.trim() || "New role"}</h2>{draft.gate && draft.stage === "before-qa" && <span className="chip info">Gate</span>}</div>
          <div className="sub">{stageLabel(draft.stage)}{role ? ` · ${role.dir}` : " · not saved yet"}</div>
        </div>
        <label className="row" style={{ gap: 10 }}><span className="sub">{draft.enabled ? "Enabled" : "Disabled"}</span><Toggle on={draft.enabled} onChange={(v) => set("enabled", v)} label="Role enabled" /></label>
      </div>
      {role?.warnings.map((w) => <div className="banner warnb" key={w}><Icon name="warn" className="warn" /><span>{w}</span></div>)}
      <div className="grid-f">
        <label className="field"><span>Name</span><input className="input" value={draft.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Security reviewer" /></label>
        <label className="field"><span>Description</span><input className="input" value={draft.description} onChange={(e) => set("description", e.target.value)} placeholder="One line shown in lists" /></label>
      </div>
      <div className="field">
        <span className="row" style={{ gap: 8 }}>When it runs<Support kind="engine" /></span>
        <div className="row wrap" style={{ gap: 10, alignItems: "stretch" }}>
          {STAGES.map((s) => (
            <button key={s.value} className={`opt ${draft.stage === s.value ? "on" : ""}`} style={{ flex: 1, minWidth: 200, flexDirection: "column", alignItems: "flex-start", gap: 4 }} aria-pressed={draft.stage === s.value} onClick={() => setDraft({ ...draft, stage: s.value, gate: s.value === "before-qa" ? draft.gate : false, fix: s.value === "before-qa" ? draft.fix : false })}>
              <b style={{ fontWeight: 600 }}>{s.label}</b>
              <span className="hint" style={{ textAlign: "left" }}>{s.desc}</span>
            </button>
          ))}
        </div>
      </div>
      {draft.stage === "before-qa" && (
        <div className="row" style={{ gap: 12 }}>
          <Toggle on={draft.gate} onChange={(v) => set("gate", v)} label="Gate" />
          <div className="grow"><b style={{ fontWeight: 600 }}>Gate</b><div className="sub">On: a "changes needed" verdict sends the attempt back for correction instead of to QA. If the role can't run, the task is blocked rather than going unreviewed. Off: findings are advice for QA.</div></div>
        </div>
      )}
      {draft.stage === "before-qa" && draft.gate && (
        <div className="row" style={{ gap: 12 }}>
          <Toggle on={draft.fix === true} onChange={(v) => set("fix", v)} label="Fixer" />
          <div className="grow"><b style={{ fontWeight: 600 }}>Fixer</b><div className="sub">On: when it finds problems, the role fixes them itself once per attempt, then reviews the result again. The fix runs with the tool guard on and may edit only the task's approved files; it never commits. If problems remain, the attempt goes back for correction as usual.</div></div>
        </div>
      )}
      <div className="field">
        <span className="row" style={{ gap: 8 }}>Runs on<Support kind="engine" /></span>
        {role ? (
          <div className="row wrap" style={{ gap: 10 }}>
            <select className="sel" style={{ minWidth: 260 }} value={runner?.id ?? ""} onChange={(e) => e.target.value && assign(e.target.value).catch((err) => toast("error", cleanError(err)))}>
              {!runner && <option value="">No agent: the role is skipped</option>}
              {customAgents.map((a) => <option key={a.id} value={a.id}>{a.name} · {cliName(a)}{a.model ? ` · ${a.model}` : ""}{agentsForRole(role, [a]).length ? "" : a.customRole ? ` (now on ${snap.roles.find((r) => r.id === a.customRole)?.name ?? a.customRole})` : ""}</option>)}
            </select>
            <button className="btn" onClick={() => createAgent().catch((err) => toast("error", cleanError(err)))}><Icon name="plus" size="sm" />New agent</button>
            {runner && <button className="btn ghost" onClick={() => go("agents")}>Model and effort in Agents</button>}
          </div>
        ) : (
          <span className="hint">Save the role first, then choose or create the agent that runs it.</span>
        )}
        {runner && (
          <span className={`hint ${cloudCli(runner) ? "" : "err"}`}>
            {cloudCli(runner)
              ? `${runner.name}: ${cliName(runner)} · ${runner.model || "CLI default model"}${runner.reasoning ? ` · ${effortLabel(runner.reasoning)}` : ""}${runner.fast ? " · Fast" : ""}${runner.enabled ? "" : " · agent disabled"}`
              : `${runner.name} uses ${cliName(runner)}. Roles run on Codex CLI or Claude Code; change its CLI in Agents.`}
          </span>
        )}
      </div>
      <label className="field">
        <span className="row" style={{ gap: 8 }}>Instructions<Support kind="engine" /></span>
        <textarea className="ta mono" style={{ minHeight: 220 }} value={draft.instructions} onChange={(e) => set("instructions", e.target.value)} placeholder="What this role looks for and how it decides. The engine adds the stage, the read-only rules and the task data." />
        <span className="hint">Sent to the role with the task, and for reviews the diff and check results. Saved as ROLE.md in the role's folder, so you can also edit or share it as a file.</span>
      </label>
      <div className="row wrap" style={{ gap: 10 }}>
        {role && <button className="btn ghost" onClick={() => window.api.openPath(role.dir)}><Icon name="external" size="sm" />Open folder</button>}
        {role && <button className="btn ghost danger" onClick={onDelete}>Delete</button>}
        <span className="grow" />
        {role && dirty && <button className="btn ghost" onClick={() => setDraft(toDraft(role))}>Revert</button>}
        <button className="btn primary" disabled={!dirty || saving || !draft.name.trim()} onClick={save}>{role ? "Save" : "Create role"}</button>
      </div>
    </section>
  );
}

export function WorkflowPage() {
  const { snap, setRoles, setAgents, toast } = useApp();
  const [selId, setSelId] = useState<string | null>(snap.roles[0]?.id ?? null);
  const [draft, setDraft] = useState<RoleDraft | null>(snap.roles[0] ? toDraft(snap.roles[0]) : null);
  const [deleting, setDeleting] = useState(false);
  useEffect(() => {
    void window.api.roles().then(setRoles);
  }, [setRoles]);
  const sel = snap.roles.find((r) => r.id === selId) ?? null;
  const pick = (id: string) => {
    const role = snap.roles.find((r) => r.id === id);
    if (!role) return;
    setSelId(id);
    setDraft(toDraft(role));
  };
  const startNew = (template?: RoleDraft) => {
    if (template?.id && snap.roles.some(role => role.id === template.id)) return pick(template.id);
    setSelId(null);
    setDraft(template ? { ...template } : emptyDraft());
  };
  const importFolder = async () => {
    try {
      const result = await window.api.importRoleFolder();
      setRoles(result.roles);
      if (result.imported) toast("success", `${result.imported} role${result.imported === 1 ? "" : "s"} imported`);
    } catch (e) {
      toast("error", cleanError(e));
    }
  };
  const remove = async () => {
    if (!sel) return;
    let agents = snap.agents;
    for (const a of agentsForRole(sel, snap.agents)) agents = await window.api.saveAgent({ ...a, customRole: "" });
    setAgents(agents);
    const roles = await window.api.deleteRole(sel.id);
    setRoles(roles);
    setDeleting(false);
    toast("success", `${sel.name} deleted`);
    if (roles[0]) pick(roles[0].id);
    else { setSelId(null); setDraft(null); }
  };

  return (
    <>
      <div className="row wrap" style={{ gap: 14 }}>
        <div><h1 className="h1">Workflow</h1><div className="sub">The loop every project runs. The built-in stages are fixed; add your own read-only roles at three points.</div></div>
        <span className="grow" />
        <button className="btn" onClick={importFolder}><Icon name="download" size="sm" />Import from folder</button>
        <button className="btn primary" onClick={() => startNew()}><Icon name="plus" size="sm" />New role</button>
      </div>
      <Pipeline onPick={pick} selected={selId} />
      {snap.roles.length === 0 && !draft ? (
        <Empty title="No workflow roles yet" icon="workflow">
          <span>Start from a template or create your own. Each role runs on an agent (Codex CLI or Claude Code) and never edits files.</span>
          <div className="row wrap" style={{ gap: 10, justifyContent: "center" }}>
            {TEMPLATES.map((t) => <button key={t.name} className="btn" title={t.blurb} onClick={() => startNew(t)}>{t.name} · {stageLabel(t.stage)}</button>)}
          </div>
        </Empty>
      ) : (
        <div className="split">
          <div className="stack" style={{ gap: 14 }}>
            {snap.roles.map((r) => {
              const runner = agentsForRole(r, snap.agents).find((a) => a.enabled);
              return (
                <button key={r.id} className={`item ${selId === r.id ? "on" : ""} ${r.enabled ? "" : "off"}`} onClick={() => pick(r.id)} aria-pressed={selId === r.id}>
                  <div className="row"><span className="name" style={{ fontWeight: 600, fontSize: 14 }}>{r.name}</span>{r.gate && <span className="chip info">Gate</span>}<span className="grow" />{!r.enabled && <span className="sub mut">Disabled</span>}</div>
                  <div className="row sub" style={{ fontSize: 11.5, gap: 6 }}><span>{stageLabel(r.stage)}</span><span>·</span><span className={runner ? "" : "warn"}>{runner ? runner.name : "No agent"}</span></div>
                  {r.description && <div className="sub ellipsis" style={{ fontSize: 12 }}>{r.description}</div>}
                </button>
              );
            })}
            {!selId && draft && <div className="item on"><span className="name" style={{ fontWeight: 600, fontSize: 14 }}>{draft.name.trim() || "New role"}</span><span className="sub">Not saved yet</span></div>}
            <div className="stack" style={{ gap: 6 }}>
              <span className="eyebrow">Templates</span>
              {TEMPLATES.map((t) => <button key={t.name} className="btn ghost sm" style={{ justifyContent: "flex-start" }} onClick={() => startNew(t)}><Icon name="plus" size="sm" />{t.name}<span className="sub">· {t.blurb}</span></button>)}
            </div>
          </div>
          {draft ? (
            <RoleEditor key={selId ?? "new"} role={sel} draft={draft} setDraft={setDraft} onDelete={() => setDeleting(true)} onSaved={(roles, id) => { setRoles(roles); const saved = roles.find((r) => r.id === id); setSelId(id); if (saved) setDraft(toDraft(saved)); }} />
          ) : (
            <Empty title="Select a role" icon="workflow" />
          )}
        </div>
      )}
      {deleting && sel && (
        <Modal label="Delete role" onClose={() => setDeleting(false)}>
          <h2 className="h2">Delete {sel.name}?</h2>
          <p className="sub" style={{ margin: 0 }}>Removes its folder and ROLE.md. Agents assigned to it stay, unassigned.</p>
          <div className="row"><span className="grow" /><button className="btn ghost" onClick={() => setDeleting(false)}>Cancel</button>
            <button className="btn danger-fill" onClick={() => remove().catch((e) => toast("error", cleanError(e)))}>Delete</button></div>
        </Modal>
      )}
    </>
  );
}
