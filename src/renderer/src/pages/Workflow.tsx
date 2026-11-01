import { useEffect, useState } from "react";
import type { RoleDraft } from "@shared/api";
import type { Agent, WorkflowRole } from "@shared/types";
import { cleanError, useApp } from "../store";
import { roleLabel, uid } from "../lib/format";
import { agentForRoleClient } from "../lib/agents";
import { effortLabel } from "../lib/models";
import { Icon } from "../components/Icon";
import { Support, Toggle } from "../components/ui";
import { SECOND_OPINION_ROLE_ID, SECOND_OPINION_TEMPLATE } from "@shared/workflow-templates";

/** Agents that run a role: custom-role agents whose customRole is the role's id or name. */
export function agentsForRole(role: Pick<WorkflowRole, "id" | "name">, agents: Agent[]) {
  const name = role.name.trim().toLowerCase();
  return agents.filter((a) => a.role === "custom" && (a.customRole === role.id || (name && a.customRole?.trim().toLowerCase() === name)));
}

const toDraft = (r: WorkflowRole): RoleDraft => ({ id: r.id, name: r.name, description: r.description, stage: "before-qa", gate: true, enabled: r.enabled, instructions: r.instructions });
const defaultDraft = (): RoleDraft => ({ ...SECOND_OPINION_TEMPLATE, name: "Second review", enabled: false });

function Pipeline({ review }: { review: { on: boolean; runner: Agent | null } }) {
  const { snap, activeProject } = useApp();
  const builtIn = (role: "assessment" | "implementation" | "qa") => agentForRoleClient(role, activeProject, snap.agents);
  // Same stage boxes and chevrons as Overview › Progress "Automation cycle".
  const Arrow = () => <span className="arrow" aria-hidden="true"><Icon name="chevronRight" /></span>;
  const Step = ({ role, note }: { role: "assessment" | "implementation" | "qa"; note: string }) => (
    <div className="stage">
      <span style={{ fontWeight: 600 }}>{roleLabel[role]}</span>
      <div className="sub ellipsis">{builtIn(role)?.name ?? "Not assigned"}</div>
      <div className="hint">{note}</div>
    </div>
  );
  return (
    <section className="card pad stack" style={{ gap: 12 }} aria-label="Workflow pipeline">
      <div className="row wrap" style={{ gap: 8 }}>
        <h2 className="h2">One task through the loop</h2>
        <span className="sub">{activeProject ? `agents as resolved for ${activeProject.name}` : "default agents"}</span>
      </div>
      <div className="stages">
        <Step role="assessment" note="Picks one bounded task" />
        <Arrow />
        <Step role="implementation" note="Changes only the task's paths" />
        <Arrow />
        {review.on && (
          <>
            <div className={`stage ${review.runner ? "" : "off"}`}>
              <span style={{ fontWeight: 600 }}>Second review</span>
              <div className="sub ellipsis">{review.runner?.name ?? "Assign an agent to start"}</div>
              <div className="hint">Can send the change back</div>
            </div>
            <Arrow />
          </>
        )}
        <Step role="qa" note="Verifies and makes the commit" />
        <Arrow />
        <div className="stage"><span style={{ fontWeight: 600 }}>Next task</span><div className="sub">Back to Assessment</div></div>
      </div>
      <span className="hint">On a failed check, Assessment writes a correction and the task goes back to Implementation. Elevation and the Resolver step in when corrections stall or a task is blocked.</span>
    </section>
  );
}

/**
 * Second review: one optional read-only reviewer on its own agent, after the engine's checks and before QA. A
 * "changes needed" verdict sends the attempt back for correction; QA and Assessment read its findings.
 */
export function WorkflowPage() {
  const { snap, setRoles, setAgents, toast, go, activeProject } = useApp();
  useEffect(() => {
    void window.api.roles().then(setRoles);
  }, [setRoles]);
  const role = snap.roles.find((r) => r.id === SECOND_OPINION_ROLE_ID) ?? null;
  const [draft, setDraft] = useState<RoleDraft>(role ? toDraft(role) : defaultDraft());
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (role) setDraft(toDraft(role)); }, [role?.id, role?.enabled, role?.instructions]);
  const runners = role ? agentsForRole(role, snap.agents) : [];
  const runner = runners.find((a) => a.enabled) ?? runners[0] ?? null;
  const customAgents = snap.agents.filter((a) => a.role === "custom");
  const cliName = (a: Agent) => snap.clis.find((c) => c.id === a.cliId)?.name ?? "No CLI";
  const cloudCli = (a: Agent) => ["codex", "claude"].includes(snap.clis.find((c) => c.id === a.cliId)?.kind ?? "");
  const dirty = !role || JSON.stringify(draft) !== JSON.stringify(toDraft(role));
  const otherRoles = snap.roles.filter((r) => r.id !== SECOND_OPINION_ROLE_ID && r.enabled);

  const save = async (next: RoleDraft = draft) => {
    setSaving(true);
    try {
      setRoles(await window.api.saveRole({ ...next, id: SECOND_OPINION_ROLE_ID, stage: "before-qa", gate: true }));
      toast("success", next.enabled ? "Second review saved" : "Second review off");
    } catch (e) {
      toast("error", cleanError(e));
    } finally {
      setSaving(false);
    }
  };
  /** Point one agent at the review; other agents on it are unassigned so it has a single runner. */
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
    // A second opinion: on the CLI QA does not use.
    const qa = agentForRoleClient("qa", activeProject, snap.agents);
    const qaKind = snap.clis.find((c) => c.id === qa?.cliId)?.kind;
    const cli = snap.clis.find((c) => c.kind === (qaKind === "codex" ? "claude" : "codex")) ?? snap.clis.find((c) => c.kind === "claude");
    if (!cli) return toast("error", "Add a Codex CLI or Claude Code connection first (CLIs).");
    const agent: Agent = {
      id: uid("agent"), name: "Second review agent", role: "custom", customRole: role.id, cliId: cli.id, model: "", reasoning: "medium", fast: false,
      contextTokens: 0, maxOutputTokens: snap.engine.defaults.maxOutputTokens, timeoutSeconds: snap.engine.defaults.timeoutSeconds, instructions: "", skills: [], enabled: true,
    };
    for (const a of runners) await window.api.saveAgent({ ...a, customRole: "" });
    setAgents(await window.api.saveAgent(agent));
    toast("success", `${agent.name} created on ${cli.name}. Pick its model in Agents.`);
  };

  return (
    <>
      <div className="row wrap" style={{ gap: 14 }}>
        <div><h1 className="h1">Workflow</h1><div className="sub">The loop every project runs, with an optional second review before QA.</div></div>
      </div>
      <Pipeline review={{ on: role?.enabled === true, runner: role?.enabled ? runner : null }} />
      <section className="card pad stack fade-in" style={{ gap: 18 }} aria-label="Second review">
        <div className="row wrap" style={{ gap: 12 }}>
          <div className="grow">
            <h2 className="h1">Second review</h2>
            <div className="sub">A read-only review on its own agent, after the engine's checks and before QA. When it finds a concrete problem the attempt goes back for correction instead of to QA; if it can't run, the task stops rather than going unreviewed.</div>
          </div>
          <label className="row" style={{ gap: 10 }}><span className="sub">{draft.enabled ? "On" : "Off"}</span><Toggle on={draft.enabled} onChange={(v) => { const next = { ...draft, enabled: v }; setDraft(next); void save(next); }} label="Second review" /></label>
        </div>
        {otherRoles.length > 0 && (
          <div className="banner warnb"><Icon name="warn" className="warn" /><span>Custom roles from earlier versions are no longer run: {otherRoles.map((r) => r.name).join(", ")}. Their folders are kept.</span></div>
        )}
        <div className="field">
          <span className="row" style={{ gap: 8 }}>Runs on<Support kind="engine" /></span>
          {role ? (
            <div className="row wrap" style={{ gap: 10 }}>
              <select className="sel" style={{ minWidth: 260 }} value={runner?.id ?? ""} aria-label="Second review agent" onChange={(e) => e.target.value && assign(e.target.value).catch((err) => toast("error", cleanError(err)))}>
                {!runner && <option value="">No agent yet</option>}
                {customAgents.map((a) => <option key={a.id} value={a.id}>{a.name} · {cliName(a)}{a.model ? ` · ${a.model}` : ""}</option>)}
              </select>
              <button className="btn" onClick={() => createAgent().catch((err) => toast("error", cleanError(err)))}><Icon name="plus" size="sm" />New agent</button>
              {runner && <button className="btn ghost" onClick={() => go("agents")}>Model and effort in Agents</button>}
            </div>
          ) : (
            <span className="hint">Turn it on (or save) first, then choose or create the agent that runs it.</span>
          )}
          {runner && (
            <span className={`hint ${cloudCli(runner) ? "" : "err"}`}>
              {cloudCli(runner)
                ? `${runner.name}: ${cliName(runner)} · ${runner.model || "CLI default model"}${runner.reasoning ? ` · ${effortLabel(runner.reasoning)}` : ""}${runner.fast ? " · Fast" : ""}. It must use a different CLI from QA.`
                : `${runner.name} uses ${cliName(runner)}. The review runs on Codex CLI or Claude Code; change its CLI in Agents.`}
            </span>
          )}
        </div>
        <label className="field">
          <span className="row" style={{ gap: 8 }}>Instructions<Support kind="engine" /></span>
          <textarea className="ta mono" style={{ minHeight: 200 }} value={draft.instructions} onChange={(e) => setDraft({ ...draft, instructions: e.target.value })} aria-label="Second review instructions" />
          <span className="hint">Sent with the task, the diff and the engine's check results. Saved as ROLE.md in its folder.</span>
        </label>
        <div className="row wrap" style={{ gap: 10 }}>
          {role && <button className="btn ghost" onClick={() => window.api.openPath(role.dir)}><Icon name="external" size="sm" />Open folder</button>}
          <span className="grow" />
          {role && dirty && <button className="btn" onClick={() => setDraft(toDraft(role))}>Revert</button>}
          {!role && <button className="btn" onClick={() => setDraft(defaultDraft())}>Default instructions</button>}
          <button className="btn primary" disabled={(!dirty && Boolean(role)) || saving || !draft.instructions.trim()} onClick={() => void save()}>Save</button>
        </div>
      </section>
    </>
  );
}
