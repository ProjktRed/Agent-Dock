import { useEffect, useState } from "react";
import type { Project, ProjectSkillInfo } from "@shared/types";
import { cleanError, useApp } from "../../store";
import { Spinner, Toggle } from "../../components/ui";

const CLOUD_WRITERS = ["codex", "claude"];
const LOCAL_WRITERS = ["llamacpp", "ollama", "openai"];
/** Same limit as src/main/project-skill.ts. */
const MAX_CHARS = 10_000;

/**
 * Projects › Project skill: a read-only agent drafts a SKILL.md from the workspace (layout, commands, conventions,
 * pitfalls); you review and edit it; Save stores it in the project's state folder and, when on, every role of
 * this project gets it at the next start.
 */
export function ProjectSkillTab({ project }: { project: Project }) {
  const { snap, toast, refresh } = useApp();
  const writers = snap.clis.filter((c) => CLOUD_WRITERS.includes(c.kind) || LOCAL_WRITERS.includes(c.kind));
  const [info, setInfo] = useState<ProjectSkillInfo | null>(null);
  const [text, setText] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [writerId, setWriterId] = useState(writers.find((c) => CLOUD_WRITERS.includes(c.kind))?.id ?? writers[0]?.id ?? "");
  const [model, setModel] = useState("");
  const [generating, setGenerating] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const writer = writers.find((c) => c.id === writerId);
  const local = Boolean(writer && LOCAL_WRITERS.includes(writer.kind));

  useEffect(() => {
    let live = true;
    setInfo(null); setError(null);
    window.api.projectSkill(project.id).then((i) => {
      if (!live) return;
      setInfo(i); setText(i.text ?? ""); setEnabled(i.text === null ? true : i.enabled);
    }, (e) => live && setError(cleanError(e)));
    return () => { live = false; };
  }, [project.id]);

  const generate = async () => {
    if (!writer) return;
    setGenerating(true); setError(null); setElapsed(0);
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    try {
      setText(await window.api.generateProjectSkill(project.id, writer.id, model.trim() || (local ? writer.defaultModel ?? "" : "") || null));
    } catch (e) {
      setError(cleanError(e));
    } finally {
      clearInterval(timer);
      setGenerating(false);
    }
  };
  const save = async (value: string | null, on: boolean) => {
    setSaving(true); setError(null);
    try {
      const saved = await window.api.saveProjectSkill(project.id, value, on);
      setInfo(saved); setText(saved.text ?? ""); setEnabled(saved.text === null ? true : saved.enabled);
      await refresh();
      toast("success", value === null ? "Project skill removed." : saved.enabled ? "Project skill saved. The project's agents get it from the next start." : "Project skill saved, but off: agents do not get it.");
    } catch (e) {
      setError(cleanError(e));
    } finally {
      setSaving(false);
    }
  };

  if (!info && !error) return <div className="well pad"><Spinner /></div>;
  const dirty = text !== (info?.text ?? "") || (info?.text !== null && enabled !== info?.enabled);

  return (
    <div className="fade-in stack" style={{ gap: 14 }}>
      <div className="well pad stack" style={{ gap: 10 }}>
        <div className="sub">
          A skill written for this project: its layout, the exact build and test commands, the conventions its code follows and the pitfalls an agent would otherwise hit.
          An agent drafts it by reading the workspace (read-only); you review it before it is used. It is kept in Agent Dock's state folder, not in the repository.
        </div>
        <div className="row wrap" style={{ gap: 10, alignItems: "flex-end" }}>
          <label className="field"><span>Written by</span>
            <select className="sel" value={writerId} disabled={generating} onChange={(e) => { setWriterId(e.target.value); setModel(""); }}>
              {!writers.length && <option value="">No connections (add one in CLIs)</option>}
              <optgroup label="Cloud (reads the workspace)">{writers.filter((c) => CLOUD_WRITERS.includes(c.kind)).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</optgroup>
              <optgroup label="Local AI (gets a summary)">{writers.filter((c) => LOCAL_WRITERS.includes(c.kind)).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</optgroup>
            </select>
          </label>
          <label className="field"><span>Model{local ? "" : " (optional)"}</span>
            <input className="input mono" list="skill-writer-models" value={model} disabled={generating} onChange={(e) => setModel(e.target.value)} placeholder={writer?.defaultModel ?? (local ? "model id" : "CLI default")} />
            <datalist id="skill-writer-models">{(writer?.collected?.models ?? []).map((m) => <option key={m.id} value={m.id} />)}</datalist>
          </label>
          {!generating && <button className="btn" disabled={!writer || (local && !model.trim() && !writer.defaultModel)} onClick={() => void generate()}>{info?.text || text ? "Generate again" : "Generate skill"}</button>}
        </div>
        {generating && (
          <div className="row" style={{ gap: 10 }}>
            <Spinner /><span className="grow">Writing the skill… {elapsed}s. {local ? "The model gets the file list, manifests and key files." : "The agent reads the workspace (read-only)."}</span>
            <button className="btn sm" onClick={() => void window.api.cancelProjectSkill(project.id)}>Cancel</button>
          </div>
        )}
      </div>

      {(text || info?.text) && (
        <>
          <textarea className="ta mono" style={{ minHeight: 360 }} value={text} disabled={generating} onChange={(e) => setText(e.target.value)} aria-label="Project skill (SKILL.md)" />
          <div className="row wrap" style={{ gap: 12 }}>
            <label className="row" style={{ gap: 10 }}><Toggle on={enabled} onChange={setEnabled} label="Give the project's agents this skill" /><span>Give this project's agents this skill (every role, from the next start)</span></label>
            <span className="grow" />
            <span className={`sub tnum ${text.length > MAX_CHARS ? "err" : ""}`}>{text.length.toLocaleString()} / {MAX_CHARS.toLocaleString()} characters</span>
          </div>
          <div className="row" style={{ gap: 8 }}>
            {info?.text && <button className="btn sm" onClick={() => window.api.openPath(info.path)}>Open file</button>}
            <span className="grow" />
            {info?.text && <button className="btn ghost danger" disabled={saving || generating} onClick={() => void save(null, false)}>Remove skill</button>}
            <button className="btn primary" disabled={saving || generating || !text.trim() || !dirty} onClick={() => void save(text, enabled)}>{saving && <Spinner />}Save</button>
          </div>
        </>
      )}
      {error && <div className="banner errb" role="alert"><span className="err">{error}</span></div>}
    </div>
  );
}
