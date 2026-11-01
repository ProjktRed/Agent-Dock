import { useEffect, useState } from "react";
import type { AddProjectRequest, CliConnection, DirectoryInspection, Project } from "@shared/types";
import { cleanError, useApp } from "../../store";
import { Modal, Spinner, St, Toggle } from "../../components/ui";
import { plural } from "../../lib/format";
import { planCounts } from "../../lib/plan-text";

type Mode = "local" | "github" | "new";
const MODES: { value: Mode; label: string; help: string }[] = [
  { value: "local", label: "Local project", help: "Register a folder that already exists on this PC. Git and the implementation plan are detected automatically." },
  { value: "github", label: "GitHub project", help: "Enter a repository URL, choose a branch and where to clone it. Uses your local git credentials." },
  { value: "new", label: "New project", help: "Create an empty workspace, optionally with Git and a starter implementation plan." },
];

const CLOUD_PLANNERS = ["codex", "claude"];
const LOCAL_PLANNERS = ["llamacpp", "ollama", "openai"];
const plannerModels = (c: CliConnection | undefined) => (c?.collected?.models ?? []).map((m) => m.id);

/** After the project exists: generate a plan, let the user edit it, then write and commit it. Nothing is written before Save. */
function PlanStep({ project, connection, model, onDone }: { project: Project; connection: CliConnection; model: string; onDone: () => void }) {
  const [state, setState] = useState<"running" | "review" | "error">("running");
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [saving, setSaving] = useState(false);
  const [run, setRun] = useState(0);
  useEffect(() => {
    let live = true;
    setState("running"); setError(null); setElapsed(0);
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    window.api.generatePlan(project.id, connection.id, model || null)
      .then((plan) => { if (live) { setText(plan); setState("review"); } })
      .catch((e) => { if (live) { setError(cleanError(e)); setState("error"); } })
      .finally(() => clearInterval(timer));
    return () => { live = false; clearInterval(timer); };
  }, [run]);
  const { phases, tasks } = planCounts(text);
  const save = async () => {
    setSaving(true); setError(null);
    try { await window.api.savePlan(project.id, text); onDone(); } catch (e) { setError(cleanError(e)); } finally { setSaving(false); }
  };
  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="row" style={{ gap: 8 }}>
        <span className="grow" style={{ fontWeight: 600 }}>Implementation plan for {project.name}</span>
        <span className="sub">Planner: {connection.name}{model ? ` · ${model}` : ""}</span>
      </div>
      {state === "running" && (
        <div className="well pad row" style={{ gap: 10, minHeight: 120 }}>
          <Spinner /><span className="grow">Planning… {elapsed}s. {CLOUD_PLANNERS.includes(connection.kind) ? "The planner reads the workspace (read-only)." : "The planner gets the file list and README."}</span>
          <button className="btn" onClick={() => { void window.api.cancelPlan(project.id); }}>Cancel planning</button>
        </div>
      )}
      {state === "review" && (
        <>
          <textarea className="ta mono" style={{ minHeight: 320 }} value={text} onChange={(e) => setText(e.target.value)} aria-label="Generated implementation plan" />
          <span className="sub">{plural(phases, "phase")} · {plural(tasks, "task")}. Edit freely; each phase needs “## Phase N — Title” and “- [ ]” tasks. Save writes IMPLEMENTATION_PLAN.md{project.path ? " and commits only that file in a Git repository" : ""}.</span>
        </>
      )}
      {error && <div className="banner errb" role="alert"><span className="err">{error}</span></div>}
      <div className="row" style={{ gap: 8 }}>
        <span className="grow" />
        <button className="btn ghost" disabled={saving} onClick={onDone}>Skip plan</button>
        {state !== "running" && <button className="btn" disabled={saving} onClick={() => setRun(run + 1)}>Regenerate</button>}
        {state === "review" && <button className="btn primary" disabled={saving || !phases || !tasks} onClick={() => void save()}>{saving && <Spinner />}Save plan</button>}
      </div>
    </div>
  );
}

export function AddProjectDialog({ onClose, onAdded }: { onClose: () => void; onAdded: (p: Project) => void }) {
  const { snap } = useApp();
  const planners = snap.clis.filter((c) => CLOUD_PLANNERS.includes(c.kind) || LOCAL_PLANNERS.includes(c.kind));
  const [makePlan, setMakePlan] = useState(false);
  const [plannerId, setPlannerId] = useState(planners[0]?.id ?? "");
  const [plannerModel, setPlannerModel] = useState("");
  const [planning, setPlanning] = useState<Project | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const planner = planners.find((c) => c.id === plannerId);
  const local = Boolean(planner && LOCAL_PLANNERS.includes(planner.kind));
  const [mode, setMode] = useState<Mode>("local");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [objective, setObjective] = useState("");
  // local
  const [inspection, setInspection] = useState<DirectoryInspection | null>(null);
  const [localName, setLocalName] = useState("");
  // github
  const [url, setUrl] = useState("");
  const [branch, setBranch] = useState("");
  const [ghParent, setGhParent] = useState("");
  const [ghName, setGhName] = useState("");
  // new
  const [newParent, setNewParent] = useState("");
  const [newName, setNewName] = useState("");
  const [initGit, setInitGit] = useState(true);
  const [starterPlan, setStarterPlan] = useState(true);

  const browseLocal = async () => {
    const dir = await window.api.pickDirectory("Choose the project folder");
    if (!dir) return;
    const info = await window.api.inspectDirectory(dir);
    setInspection(info);
    if (!localName) setLocalName(info.suggestedName);
  };

  const name = mode === "local" ? localName : mode === "github" ? ghName : newName;
  const duplicate = snap.projects.some((p) => p.name.toLowerCase() === name.trim().toLowerCase());
  const offerPlan = mode !== "local" || Boolean(inspection && !inspection.planFile);
  const planning_ = makePlan && offerPlan;
  const ready =
    !duplicate &&
    name.trim() &&
    (!planning_ || (Boolean(planner) && objective.trim() && (!local || plannerModel.trim() || planner?.defaultModel))) &&
    (mode === "local" ? Boolean(inspection?.exists) : mode === "github" ? /^(https:\/\/|git@)/.test(url.trim()) && ghParent : Boolean(newParent));

  const submit = async () => {
    setBusy(true);
    setError(null);
    const request: AddProjectRequest =
      mode === "local"
        ? { mode, path: inspection!.path, name: localName, objective }
        : mode === "github"
          ? { mode, url, branch, parentDir: ghParent, name: ghName, objective }
          : { mode, parentDir: newParent, name: newName, initGit, starterPlan: starterPlan && !planning_, objective };
    try {
      const added = await window.api.addProject(request);
      if (!planning_) return onAdded(added);
      // A cloned repository may already have a plan: keep it and skip planning.
      if ((await window.api.inspectDirectory(added.path)).planFile) {
        setNotice("This repository already has IMPLEMENTATION_PLAN.md, so no plan was generated.");
        return onAdded(added);
      }
      setPlanning(added);
    } catch (e) {
      setError(cleanError(e));
    } finally {
      setBusy(false);
    }
  };

  if (planning) {
    return (
      <Modal label="Create implementation plan" wide onClose={() => { void window.api.cancelPlan(planning.id); onAdded(planning); }} title="Create implementation plan">
        <PlanStep project={planning} connection={planner!} model={plannerModel.trim() || (local ? planner?.defaultModel ?? "" : "")} onDone={() => onAdded(planning)} />
      </Modal>
    );
  }

  return (
    <Modal label="Add project" wide onClose={onClose} title={<>Add project<div className="sub" style={{ fontWeight: 400 }}>Registering never moves, rewrites or deletes existing files.</div></>}>
      <div style={{ display: "grid", gridTemplateColumns: "250px minmax(0, 1fr)", gap: 24 }}>
        <div className="stack" style={{ gap: 12 }}>
          {MODES.map((m) => (
            <button key={m.value} className={`opt ${mode === m.value ? "on" : ""}`} onClick={() => setMode(m.value)} aria-pressed={mode === m.value}>
              <span style={{ fontWeight: 600 }}>{m.label}</span>
            </button>
          ))}
          <div className="sub" style={{ padding: "4px 4px 0" }}>{MODES.find((m) => m.value === mode)!.help}</div>
        </div>
        <div className="well pad stack" style={{ gap: 16, minHeight: 340 }}>
          {mode === "local" && (
            <>
              <label className="field">
                <span>Local directory</span>
                <div className="row">
                  <input className="input mono" value={inspection?.path ?? ""} placeholder="Choose a folder…" readOnly />
                  <button className="btn" onClick={browseLocal}>Browse…</button>
                </div>
              </label>
              {inspection && (
                <div className="stack fade-in" style={{ gap: 8 }}>
                  <div className="eyebrow">Detected</div>
                  <div className="row"><St kind={inspection.isRepo ? "done" : "blocked"} />{inspection.isRepo ? <>Git repository · branch <span className="mono">{inspection.branch ?? "?"}</span>{inspection.remote && <> · <span className="mono">{inspection.remote}</span></>}</> : "Not a Git repository: the engine needs one (it checks a clean baseline before each task)"}</div>
                  <div className="row"><St kind={inspection.planFile ? "done" : "pending"} />{inspection.planFile ? <>Implementation plan · <span className="mono">{inspection.planFile}</span> ({inspection.planSummary})</> : <span className="sub">No IMPLEMENTATION_PLAN.md. Progress is tracked per task until one exists.</span>}</div>
                </div>
              )}
              <label className="field"><span>Project name</span><input className={`input ${duplicate ? "bad" : ""}`} value={localName} onChange={(e) => setLocalName(e.target.value)} /></label>
            </>
          )}
          {mode === "github" && (
            <>
              <label className="field"><span>Repository URL</span><input className="input mono" value={url} onChange={(e) => { setUrl(e.target.value); if (!ghName) setGhName(e.target.value.split("/").pop()?.replace(/\.git$/, "") ?? ""); }} placeholder="https://github.com/owner/repo.git" /></label>
              <div className="grid-f">
                <label className="field"><span>Branch</span><input className="input mono" value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="default branch" /></label>
                <label className="field"><span>Project name</span><input className={`input ${duplicate ? "bad" : ""}`} value={ghName} onChange={(e) => setGhName(e.target.value)} /></label>
              </div>
              <label className="field">
                <span>Clone into</span>
                <div className="row">
                  <input className="input mono" value={ghParent ? `${ghParent}\\${ghName}` : ""} placeholder="Choose a parent folder…" readOnly />
                  <button className="btn" onClick={async () => setGhParent((await window.api.pickDirectory("Clone into this folder")) ?? ghParent)}>Browse…</button>
                </div>
                <span className="hint">If the folder already holds a clone it is linked instead of cloned again.</span>
              </label>
            </>
          )}
          {mode === "new" && (
            <>
              <div className="grid-f">
                <label className="field"><span>Project name</span><input className={`input ${duplicate ? "bad" : ""}`} value={newName} onChange={(e) => setNewName(e.target.value)} /></label>
                <label className="field">
                  <span>Parent directory</span>
                  <div className="row">
                    <input className="input mono" value={newParent} readOnly placeholder="Choose…" />
                    <button className="btn" onClick={async () => setNewParent((await window.api.pickDirectory("Create the project inside this folder")) ?? newParent)}>Browse…</button>
                  </div>
                </label>
              </div>
              <div className="setrow"><div className="grow"><div className="lt">Initialize Git repository</div><div className="ld">git init on main plus an initial commit, which the engine needs as a baseline</div></div><Toggle on={initGit} onChange={setInitGit} label="Initialize Git" /></div>
              {!makePlan && <div className="setrow"><div className="grow"><div className="lt">Add starter implementation plan</div><div className="ld">Creates IMPLEMENTATION_PLAN.md in the format the engine reads</div></div><Toggle on={starterPlan} onChange={setStarterPlan} label="Starter plan" /></div>}
            </>
          )}
          {offerPlan && (
            <div className="stack" style={{ gap: 10 }}>
              <div className="setrow"><div className="grow"><div className="lt">Create plan with a model</div><div className="ld">After the project is added, a planner writes IMPLEMENTATION_PLAN.md toward the objective. You review and edit it before anything is saved.</div></div><Toggle on={makePlan} onChange={setMakePlan} label="Create plan with a model" /></div>
              {makePlan && (
                <div className="grid-f">
                  <label className="field"><span>Planner</span>
                    <select className="sel" value={plannerId} onChange={(e) => { setPlannerId(e.target.value); setPlannerModel(""); }}>
                      {!planners.length && <option value="">No planner connections (add one in CLIs)</option>}
                      <optgroup label="Cloud (reads the workspace)">{planners.filter((c) => CLOUD_PLANNERS.includes(c.kind)).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</optgroup>
                      <optgroup label="Local AI">{planners.filter((c) => LOCAL_PLANNERS.includes(c.kind)).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</optgroup>
                    </select>
                  </label>
                  <label className="field"><span>Model{local ? "" : " (optional)"}</span>
                    <input className="input mono" list="planner-models" value={plannerModel} onChange={(e) => setPlannerModel(e.target.value)} placeholder={planner?.defaultModel ?? (local ? "model id" : "CLI default")} />
                    <datalist id="planner-models">{plannerModels(planner).map((m) => <option key={m} value={m} />)}</datalist>
                  </label>
                </div>
              )}
              {makePlan && mode === "github" && <span className="hint">Skipped if the repository already has IMPLEMENTATION_PLAN.md.</span>}
            </div>
          )}
          <label className="field"><span>{planning_ ? "Objective (the planner plans toward it)" : "Objective (optional, can be set later)"}</span><textarea className="ta" style={{ minHeight: 64 }} value={objective} onChange={(e) => setObjective(e.target.value)} placeholder="What should the automation work toward?" /></label>
        </div>
      </div>
      {error && <div className="banner errb" role="alert"><span className="err">{error}</span></div>}
      {notice && <div className="banner"><span>{notice}</span></div>}
      <div className="row">
        <span className="sub grow">{duplicate ? `A project named “${name}” is already registered.` : ""}</span>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!ready || busy} onClick={submit}>
          {busy && <Spinner />}
          {{ local: "Register workspace", github: busy ? "Cloning…" : "Clone and link", new: "Create workspace" }[mode]}
        </button>
      </div>
    </Modal>
  );
}
