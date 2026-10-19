import { useEffect, useState } from "react";
import type { Agent, CliConnection, Role } from "@shared/types";
import { cleanError, useApp } from "../store";
import { connectionMeta } from "../lib/format";
import { Spinner, St } from "../components/ui";
import { Icon } from "../components/Icon";
import { AddProjectDialog } from "./projects/AddProjectDialog";
import { EngineGuardrails } from "./Settings";

const PLANNING_ROLES: Role[] = ["qa", "assessment", "elevation"];
const cliLabel = (c: CliConnection | undefined) => (c ? (c.kind === "claude" ? "Claude Code" : c.kind === "codex" ? "Codex" : c.name) : "no CLI");

/**
 * Local providers found during setup: offer to collect their model lists from the provider itself.
 * llama.cpp counts as found when it answers or its launcher points at a models folder.
 */
function LocalModelsPrompt() {
  const { snap, healths, setClis, toast } = useApp();
  const [modelsDir, setModelsDir] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [skipped, setSkipped] = useState(false);
  useEffect(() => {
    void window.api.detectModelsDir().then(setModelsDir);
  }, []);
  const local = snap.clis.filter((c) => (c.kind === "ollama" && healths[c.id]?.state === "connected") || (c.kind === "llamacpp" && (healths[c.id]?.state === "connected" || modelsDir)));
  const pending = local.filter((c) => !c.collected?.models.length);
  if (skipped || modelsDir === undefined || local.length === 0) return null;
  if (pending.length === 0) {
    return (
      <div className="row sub" style={{ gap: 8 }}>
        <St kind="done" />
        {local.map((c) => `${c.name}: ${c.collected!.models.length} models`).join(" · ")} · refresh any time in CLIs › Models
      </div>
    );
  }
  const collect = async () => {
    setBusy(true);
    try {
      for (const c of pending) {
        if (c.kind === "llamacpp" && !c.modelsDir && modelsDir) setClis(await window.api.saveCli({ ...c, modelsDir }));
        const clis = await window.api.collectModels(c.id);
        setClis(clis);
        const result = clis.find((x) => x.id === c.id)?.collected;
        toast(result?.error ? "warning" : "success", result?.error ?? `${result?.models.length ?? 0} models from ${c.name}`);
      }
    } catch (e) {
      toast("error", cleanError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="banner" style={{ alignItems: "flex-start" }}>
      <Icon name="active" className="ok" />
      <div className="stack grow" style={{ gap: 8 }}>
        <span>
          <b style={{ fontWeight: 600 }}>Local providers found: {pending.map((c) => c.name).join(", ")}.</b> Collect their model lists so you can pick the Implementation model?
          {pending.some((c) => c.kind === "llamacpp") && modelsDir && <span className="sub"> llama.cpp will list every model in <span className="mono">{modelsDir}</span> (router mode).</span>}
        </span>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn primary sm" disabled={busy} onClick={() => void collect()}>{busy && <Spinner />}Collect model lists</button>
          <button className="btn ghost sm" disabled={busy} onClick={() => setSkipped(true)}>Skip</button>
        </div>
      </div>
    </div>
  );
}

export function FirstLaunch() {
  const { snap, healths, go, saveSettings, setProjects, setActive, setAgents, setClis, toast } = useApp();
  const [checking, setChecking] = useState(false);
  const [adding, setAdding] = useState(false);
  const [git, setGit] = useState<string | null | undefined>(undefined);
  const [switching, setSwitching] = useState(false);
  const detectGit = () => window.api.detectOnPath("git").then((d) => setGit(d.found[0] ? (d.found[0].version ? `Git ${d.found[0].version}` : "Git found") : null), () => setGit(null));
  useEffect(() => { void detectGit(); }, []);
  // Only what the agents actually use is required: Git, the planning/QA CLI, and the Implementation agent's
  // CLI (plus a local model runtime when it is Cline or OpenCode on a local provider).
  const cliOf = (id?: string) => snap.clis.find((c) => c.id === id);
  const ready = (id?: string) => { const h = id ? healths[id] : undefined; return Boolean(cliOf(id) && h?.state === "connected" && h.auth.state !== "required"); };
  const stateOf = (c: CliConnection) => `${c.name}: ${healths[c.id] ? connectionMeta[healths[c.id].state].label : "checking…"}`;
  const agentFor = (role: Role) => snap.agents.find((a) => a.role === role && a.enabled);
  const orchestrators = snap.clis.filter((c) => (c.kind === "codex" || c.kind === "claude") && ready(c.id));
  const planning = PLANNING_ROLES.map(agentFor).filter((a): a is Agent => Boolean(a));
  const planningOk = planning.length > 0 && planning.every((a) => ready(a.cliId));
  const impl = agentFor("implementation");
  const implCli = cliOf(impl?.cliId);
  const cloudImpl = implCli?.kind === "codex" || implCli?.kind === "claude";
  const localRuntime = snap.clis.filter((c) => c.kind === "llamacpp" || c.kind === "ollama");
  const implProviderOk = impl?.provider === "openai" ? ready(impl.providerCliId) : localRuntime.some((c) => ready(c.id) && (!impl?.provider || c.kind === impl.provider));
  const implOk = Boolean(impl && ready(impl.cliId) && (cloudImpl || implProviderOk));
  const planningClis = [...new Set(planning.map((a) => a.cliId))].map(cliOf).filter((c): c is CliConnection => Boolean(c));
  const met = [
    { label: "Git", why: "projects are Git repositories, and every change is checked against Git", ok: Boolean(git), states: [git === undefined ? "checking…" : git ?? "git was not found on PATH: install Git for Windows, then Detect again"], fix: null as null | { label: string; run: () => Promise<void> } },
    { label: "Planning and QA", why: "Codex CLI or Claude Code chooses tasks, reviews every change and commits it", ok: planningOk,
      states: planningClis.length ? planningClis.map(stateOf) : ["no enabled QA, Assessment or Elevation agent"],
      fix: !planningOk && orchestrators[0] ? { label: `Use ${cliLabel(orchestrators[0])} for planning and QA`, run: () => assign(PLANNING_ROLES, orchestrators[0]) } : null },
    { label: "Implementation", why: cloudImpl ? `${cliLabel(implCli)} edits the repository within each task's files` : "Cline with a local model (llama.cpp or Ollama), or Codex CLI / Claude Code, edits the repository", ok: implOk,
      states: [...(implCli ? [stateOf(implCli)] : ["no enabled Implementation agent"]), ...(!cloudImpl && impl?.provider !== "openai" ? localRuntime.map(stateOf) : [])],
      fix: !implOk && orchestrators[0] ? { label: `Implement with ${cliLabel(orchestrators[0])} instead`, run: () => assign(["implementation"], orchestrators[0]) } : null },
  ];
  /** Points these roles' agents at one connected CLI, on its default model. */
  async function assign(roles: Role[], cli: CliConnection) {
    setSwitching(true);
    try {
      let list = snap.agents;
      for (const agent of snap.agents.filter((a) => roles.includes(a.role))) {
        list = await window.api.saveAgent({ ...agent, cliId: cli.id, model: "", reasoning: undefined, fast: false, provider: undefined, providerCliId: undefined, backupAgentId: agent.backupAgentId && list.find((b) => b.id === agent.backupAgentId)?.cliId === cli.id ? undefined : agent.backupAgentId, enabled: agent.role === "implementation" ? true : agent.enabled });
      }
      setAgents(list);
      toast("success", `${roles.includes("implementation") ? "Implementation now uses" : "Planning and QA now use"} ${cliLabel(cli)} (its default model; change it in Agents)`);
    } catch (e) {
      toast("error", cleanError(e));
    } finally {
      setSwitching(false);
    }
  }
  const cliDone = met.every((m) => m.ok);
  const hasProject = snap.projects.length > 0;
  const step = !cliDone ? 1 : !hasProject ? 2 : 3;
  const cls = (n: number) => (n < step ? "done" : n === step ? "cur" : "locked");
  const finish = () => saveSettings({ ...snap.settings, onboardingComplete: true }).then(() => go("overview"));

  return (
    <div className="stack" style={{ gap: 24, width: "100%", maxWidth: 780, margin: "16px auto" }}>
      <div className="stack" style={{ gap: 6 }}>
        <h1 className="h1" style={{ fontSize: 24 }}>Set up your command center</h1>
        <p className="sub" style={{ margin: 0 }}>Three steps. Nothing runs until you start it, and setup changes no files in your repositories.</p>
      </div>

      <section className={`stepcard ${cls(1)}`} aria-label="Step 1">
        <div className="num-c">{step > 1 ? "✓" : 1}</div>
        <div className="stack" style={{ gap: 12 }}>
          <div><h2 className="h2">Connect the tools the engine needs</h2><div className="sub">Detected automatically from PATH and local ports.</div></div>
          <div className="well" style={{ padding: "12px 16px" }}>
            {met.map((m) => (
              <div className="row" key={m.label} style={{ minHeight: 34, alignItems: "flex-start", paddingTop: 6 }}>
                <St kind={m.ok ? "done" : "blocked"} />
                <div className="grow"><div>{m.label} <span className="sub">· {m.why}</span></div><div className="sub mono" style={{ fontSize: 11 }}>{m.states.join(" · ")}</div></div>
                {m.fix && <button className="btn sm" disabled={switching} onClick={() => void m.fix!.run()}>{m.fix.label}</button>}
              </div>
            ))}
          </div>
          <LocalModelsPrompt />
          <div className="row wrap" style={{ gap: 12 }}>
            <button className="btn" disabled={checking} onClick={async () => { setChecking(true); try { const clis = await window.api.discoverClis(); setClis(clis); await Promise.all([detectGit(), ...clis.map((c) => window.api.checkCli(c.id))]); } catch (e) { toast("error", cleanError(e)); } finally { setChecking(false); } }}>{checking && <Spinner />}Detect again</button>
            <button className="btn ghost" onClick={() => go("clis")}>Configure manually…</button>
          </div>
        </div>
      </section>

      <section className={`stepcard ${cls(2)}`} aria-label="Step 2">
        <div className="num-c">{step > 2 ? "✓" : 2}</div>
        <div className="stack" style={{ gap: 12 }}>
          <div><h2 className="h2">Add your first project</h2><div className="sub">Register a local repository, clone one from GitHub, or create a new workspace.</div></div>
          {hasProject ? <div className="row"><St kind="done" />{snap.projects[0].name}<span className="mono sub">{snap.projects[0].path}</span></div> : <div><button className="btn primary" onClick={() => setAdding(true)}>Add project…</button></div>}
        </div>
      </section>

      <section className={`stepcard ${cls(3)}`} aria-label="Step 3">
        <div className="num-c">3</div>
        <div className="stack" style={{ gap: 12 }}>
          <div><h2 className="h2">Review agents and safety defaults</h2><div className="sub">{impl ? `${impl.name} implements on ${cloudImpl ? cliLabel(implCli) : `Cline with ${impl.provider === "ollama" ? "Ollama" : impl.provider === "openai" ? "an OpenAI-compatible server" : "llama.cpp"}`}` : "No Implementation agent yet"}; {planningClis.length ? planningClis.map(cliLabel).join(" and ") : "the orchestrator"} plans and verifies. The worker tool guard is on.</div></div>
          <div className="well" style={{ padding: "4px 16px" }}>
            <EngineGuardrails />
          </div>
          <div className="row wrap" style={{ gap: 12 }}>
            <button className="btn" onClick={() => go("agents")}>Review agents</button>
            <button className="btn" onClick={() => go("settings")}>Execution &amp; safety</button>
            <button className="btn primary" onClick={finish} disabled={!hasProject}>Finish setup</button>
          </div>
        </div>
      </section>
      <div className="row"><span className="grow" /><button className="btn ghost sm" onClick={finish}>Skip setup</button></div>
      {adding && <AddProjectDialog onClose={() => setAdding(false)} onAdded={async (p) => { setAdding(false); setProjects([...snap.projects, p]); await setActive(p.id); toast("success", `${p.name} registered`); }} />}
    </div>
  );
}
