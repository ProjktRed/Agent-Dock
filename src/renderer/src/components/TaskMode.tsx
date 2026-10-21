import { useState } from "react";
import type { MaxLimits, TaskMode } from "@shared/types";
import { TASK_MODES, maxLimitsOf, suggestTaskMode, taskModeOf } from "@shared/task-mode";
import { useApp } from "../store";
import { useLimits } from "../pages/overview/UsageTab";
import { Icon } from "./Icon";
import { Modal, SetRow, Support, Toggle } from "./ui";

/** Asks before Max mode is turned on. */
export function MaxModeConfirm({ onConfirm, onClose }: { onConfirm: () => void; onClose: () => void }) {
  return (
    <Modal label="Turn on Max mode" onClose={onClose}>
      <div>
        <h2 className="h2 row" style={{ gap: 8 }}><Icon name="warn" className="warn" />Turn on Max mode?</h2>
        <p className="sub" style={{ margin: "8px 0 0" }}>Max mode removes the task size limits, so one task can change many files and use a lot of usage at once. Only turn it on if you know your model and plan can handle it.</p>
        <p className="sub" style={{ margin: "8px 0 0" }}>A <b>Max limits</b> button will appear at the bottom left of the sidebar, where you can set your own limits. The scope guard, QA and your spend budgets still apply.</p>
      </div>
      <div className="row" style={{ gap: 8 }}>
        <span className="grow" />
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={() => { onConfirm(); onClose(); }}>Turn on Max mode</button>
      </div>
    </Modal>
  );
}

/** Eco / Standard / Max; choosing Max asks first. */
export function TaskModePicker({ value, onChange, label = "Task size" }: { value: TaskMode; onChange: (mode: TaskMode) => void; label?: string }) {
  const [confirm, setConfirm] = useState(false);
  const pick = (mode: TaskMode) => (mode === value ? undefined : mode === "max" ? setConfirm(true) : onChange(mode));
  return (
    <div className="row wrap" role="radiogroup" aria-label={label} style={{ gap: 6 }}>
      {TASK_MODES.map((m) => (
        <button key={m.mode} role="radio" aria-checked={value === m.mode} className={`btn sm${value === m.mode ? " primary" : ""}`} title={m.desc} onClick={() => pick(m.mode)}>{m.label}</button>
      ))}
      {confirm && <MaxModeConfirm onConfirm={() => onChange("max")} onClose={() => setConfirm(false)} />}
    </div>
  );
}

/** Settings › Workflow rules: the default task size, the step-down and a suggestion for the current agents. */
export function TaskModeCard() {
  const { snap, saveSettings } = useApp();
  const limits = useLimits();
  const w = snap.settings.workflow;
  const mode = taskModeOf(w);
  const set = (patch: Partial<typeof w>) => void saveSettings({ ...snap.settings, workflow: { ...w, ...patch } });
  const implementation = snap.agents.find((a) => a.role === "implementation" && a.enabled) ?? null;
  const suggestion = suggestTaskMode({ implementation, clis: snap.clis, limits });
  const current = TASK_MODES.find((m) => m.mode === mode)!;
  return (
    <section className="card pad">
      <div className="row" style={{ gap: 8, marginBottom: 4 }}><h2 className="h2">Task size</h2><Support kind="engine" /></div>
      <SetRow title="Mode" desc={current.desc}>
        <TaskModePicker value={mode} onChange={(taskMode) => set({ taskMode })} />
      </SetRow>
      <SetRow title="Suggested" desc={suggestion.reason}>
        {suggestion.mode === mode
          ? <span className="chip ok">{TASK_MODES.find((m) => m.mode === suggestion.mode)!.label} (current)</span>
          : <button className="btn sm" onClick={() => set({ taskMode: suggestion.mode })}>Use {TASK_MODES.find((m) => m.mode === suggestion.mode)!.label}</button>}
      </SetRow>
      <SetRow title="Step down on repeated failures" desc="Standard or Max: a task that fails review twice is set aside (its work kept in a git stash) and redone one size smaller, Max to Standard and Standard to Eco, until its plan items are done.">
        <Toggle on={w.stepDown !== false} disabled={mode === "eco"} onChange={(stepDown) => set({ stepDown })} label="Step down on repeated failures" />
      </SetRow>
      <span className="hint">Projects can override the mode in Projects › Workflow. Eco's sizing can be tuned in Context limits with engine guardrails off.</span>
    </section>
  );
}

const MAX_FIELDS: { key: keyof MaxLimits; label: string; unit: string; desc: string }[] = [
  { key: "files", label: "Files per task", unit: "files", desc: "Most files one task may change" },
  { key: "newLines", label: "New file size", unit: "lines", desc: "Assessment keeps each new file under about this many lines" },
  { key: "readFiles", label: "Files to read", unit: "files", desc: "Most files Assessment names for the worker to read" },
  { key: "timeoutMinutes", label: "Implementation timeout", unit: "minutes", desc: "Replaces the Implementation agent's own timeout" },
];

/** Whether Max mode is on anywhere: the default, or a project's override. */
export function useMaxModeOn(): boolean {
  const { snap } = useApp();
  return taskModeOf(snap.settings.workflow) === "max" || snap.projects.some((p) => !p.archived && p.workflowOverrides.taskMode === "max");
}

/** Max limits: Max mode's own limits, all empty (no limit) at first. */
export function MaxLimitsDialog({ onClose }: { onClose: () => void }) {
  const { snap, saveSettings, toast } = useApp();
  const stored = maxLimitsOf(snap.settings.workflow);
  const [draft, setDraft] = useState<Record<keyof MaxLimits, string>>(() => Object.fromEntries(MAX_FIELDS.map((f) => [f.key, stored[f.key] ? String(stored[f.key]) : ""])) as Record<keyof MaxLimits, string>);
  const save = async () => {
    const next = { ...stored };
    for (const f of MAX_FIELDS) {
      const raw = draft[f.key].replace(/[\s,]/g, "");
      const n = raw === "" ? 0 : Number(raw);
      if (!Number.isInteger(n) || n < 0 || n > 100_000) return toast("warning", `${f.label}: a whole number, or empty for no limit.`);
      next[f.key] = n;
    }
    await saveSettings({ ...snap.settings, workflow: { ...snap.settings.workflow, maxLimits: next } });
    toast("success", "Max limits saved; they apply from the next start.");
    onClose();
  };
  return (
    <Modal label="Max limits" onClose={onClose}>
      <div>
        <h2 className="h2">Max limits</h2>
        <p className="sub" style={{ margin: "6px 0 0" }}>Limits for projects in Max mode. Leave a field empty for no limit. The scope guard, QA and spend budgets apply either way.</p>
      </div>
      {MAX_FIELDS.map((f) => (
        <label className="field" key={f.key}>
          <span>{f.label} <span className="hint">{f.desc}</span></span>
          <span className="row" style={{ gap: 8 }}>
            <input className="input mono" style={{ width: 120 }} inputMode="numeric" placeholder="No limit" value={draft[f.key]} onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })} aria-label={f.label} />
            <span className="sub">{f.unit}</span>
          </span>
        </label>
      ))}
      <div className="row" style={{ gap: 8 }}>
        <span className="grow" />
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={() => void save()}>Save</button>
      </div>
    </Modal>
  );
}
