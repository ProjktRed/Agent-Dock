import { useState } from "react";
import type { AddProjectRequest, DirectoryInspection, Project } from "@shared/types";
import { cleanError, useApp } from "../../store";
import { Modal, Spinner, St, Toggle } from "../../components/ui";

type Mode = "local" | "github" | "new";
const MODES: { value: Mode; label: string; help: string }[] = [
  { value: "local", label: "Local project", help: "Register a folder that already exists on this PC. Git and the implementation plan are detected automatically." },
  { value: "github", label: "GitHub project", help: "Enter a repository URL, choose a branch and where to clone it. Uses your local git credentials." },
  { value: "new", label: "New project", help: "Create an empty workspace, optionally with Git and a starter implementation plan." },
];

export function AddProjectDialog({ onClose, onAdded }: { onClose: () => void; onAdded: (p: Project) => void }) {
  const { snap } = useApp();
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
  const ready =
    !duplicate &&
    name.trim() &&
    (mode === "local" ? Boolean(inspection?.exists) : mode === "github" ? /^(https:\/\/|git@)/.test(url.trim()) && ghParent : Boolean(newParent));

  const submit = async () => {
    setBusy(true);
    setError(null);
    const request: AddProjectRequest =
      mode === "local"
        ? { mode, path: inspection!.path, name: localName, objective }
        : mode === "github"
          ? { mode, url, branch, parentDir: ghParent, name: ghName, objective }
          : { mode, parentDir: newParent, name: newName, initGit, starterPlan, objective };
    try {
      onAdded(await window.api.addProject(request));
    } catch (e) {
      setError(cleanError(e));
    } finally {
      setBusy(false);
    }
  };

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
              <div className="setrow"><div className="grow"><div className="lt">Add starter implementation plan</div><div className="ld">Creates IMPLEMENTATION_PLAN.md in the format the engine reads</div></div><Toggle on={starterPlan} onChange={setStarterPlan} label="Starter plan" /></div>
            </>
          )}
          <label className="field"><span>Objective (optional, can be set later)</span><textarea className="ta" style={{ minHeight: 64 }} value={objective} onChange={(e) => setObjective(e.target.value)} placeholder="What should the automation work toward?" /></label>
        </div>
      </div>
      {error && <div className="banner errb" role="alert"><span className="err">{error}</span></div>}
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
