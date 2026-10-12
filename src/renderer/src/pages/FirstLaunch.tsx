import { useState } from "react";
import type { CliKind } from "@shared/types";
import { useApp } from "../store";
import { connectionMeta } from "../lib/format";
import { Spinner, St } from "../components/ui";
import { AddProjectDialog } from "./projects/AddProjectDialog";

const REQUIREMENTS: { label: string; kinds: CliKind[]; why: string }[] = [
  { label: "Implementation worker", kinds: ["cline"], why: "Cline CLI edits the repository" },
  { label: "Local model runtime", kinds: ["llamacpp", "ollama"], why: "llama.cpp or Ollama serves the worker's model" },
  { label: "Orchestrator", kinds: ["codex", "claude"], why: "Codex CLI or Claude Code plans tasks and runs QA" },
];

export function FirstLaunch() {
  const { snap, healths, go, saveSettings, setProjects, setActive, toast } = useApp();
  const [checking, setChecking] = useState(false);
  const [adding, setAdding] = useState(false);
  const met = REQUIREMENTS.map((r) => {
    const ok = snap.clis.filter((c) => r.kinds.includes(c.kind)).find((c) => healths[c.id]?.state === "connected" && healths[c.id]?.auth.state !== "required");
    const states = snap.clis.filter((c) => r.kinds.includes(c.kind)).map((c) => `${c.name}: ${healths[c.id] ? connectionMeta[healths[c.id].state].label : "checking…"}`);
    return { ...r, ok, states };
  });
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
              </div>
            ))}
          </div>
          <div className="row wrap" style={{ gap: 12 }}>
            <button className="btn" disabled={checking} onClick={async () => { setChecking(true); await Promise.all(snap.clis.map((c) => window.api.checkCli(c.id))); setChecking(false); }}>{checking && <Spinner />}Detect again</button>
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
          <div><h2 className="h2">Review agents and safety defaults</h2><div className="sub">Default agents mirror the engine: Cline + local model implements, the orchestrator plans and verifies. The worker tool guard is on.</div></div>
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
