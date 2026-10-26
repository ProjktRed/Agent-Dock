import { useEffect, useState } from "react";
import type { ActionDecision, ActionRequest } from "@shared/types";
import { useApp } from "../store";
import { clock } from "../lib/format";
import { Modal } from "./ui";

/** Seconds left before the engine refuses the action unanswered. */
function useSecondsLeft(expiresAt: string) {
  const left = () => Math.max(0, Math.round((Date.parse(expiresAt) - Date.now()) / 1000));
  const [seconds, setSeconds] = useState(left);
  useEffect(() => {
    const timer = setInterval(() => setSeconds(left()), 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);
  return seconds;
}

/**
 * One agent action the guard could not verify (engine guard/ask.mjs): what it is and the three answers.
 * "Allow for this run" covers only this exact action (same CLI, tool, folder and text) until the run ends.
 */
export function ActionRequestCard({ projectId, request: r, project }: { projectId: string; request: ActionRequest; project?: string }) {
  const { toast, snap } = useApp();
  const [busy, setBusy] = useState(false);
  const seconds = useSecondsLeft(r.expiresAt);
  const sandboxed = snap.settings.safety.sandboxAgents === true;
  const answer = (decision: ActionDecision) => {
    setBusy(true);
    void window.api.decideAction(projectId, r.id, decision)
      .then((done) => toast(done ? "success" : "info", !done ? "That action was already answered or expired." : decision === "deny" ? "Refused." : decision === "allow-run" ? "Allowed for the rest of this run." : "Allowed once."), (error) => toast("error", (error as Error).message))
      .finally(() => setBusy(false));
  };
  return (
    <div className="well pad stack" style={{ gap: 8 }}>
      <div className="sub">
        {r.cli} · {r.tool ?? "tool"}{project ? ` · ${project}` : ""}{r.taskId ? ` · task ${r.taskId}` : ""}
      </div>
      <pre className="mono log selectable" style={{ maxHeight: 180, margin: 0, whiteSpace: "pre-wrap" }}>{r.text}</pre>
      <div className="sub">In <span className="mono">{r.cwd}</span>. Stopped because: {r.reason || "the guard could not verify it"}.</div>
      <div className="row wrap" style={{ gap: 10 }}>
        <button className="btn sm" disabled={busy} onClick={() => answer("deny")}>Refuse</button>
        <button className="btn primary sm" disabled={busy} title={`Runs once, as you${sandboxed ? " (inside the sandbox for agents' commands)" : ""}`} onClick={() => answer("allow")}>Allow once</button>
        <button className="btn sm" disabled={busy} title="This exact command, in this folder, is allowed without asking until the run ends; anything different still asks" onClick={() => answer("allow-run")}>Allow for this run</button>
        <span className="sub">Refused at {clock(r.expiresAt)} without an answer ({Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")} left).</span>
      </div>
    </div>
  );
}

/**
 * Ask instead of refuse: the oldest waiting action, over whatever page is open. "Later" hides it here; it stays on
 * the project's Overview (and on Telegram) until answered or refused at its deadline.
 */
export function ActionPrompt() {
  const { statuses, snap } = useApp();
  const [later, setLater] = useState<Set<string>>(() => new Set());
  const waiting = snap.projects.flatMap((p) => (statuses[p.id]?.actionRequests ?? []).map((request) => ({ project: p, request })))
    .filter((x) => !later.has(x.request.id))
    .sort((a, b) => a.request.createdAt.localeCompare(b.request.createdAt));
  const first = waiting[0];
  if (!first) return null;
  const close = () => setLater((prev) => new Set(prev).add(first.request.id));
  return (
    <Modal label="Agent action waiting for your answer" title={`${first.request.cli} asks to run an action${waiting.length > 1 ? ` (1 of ${waiting.length})` : ""}`} onClose={close} wide>
      <p className="sub" style={{ margin: 0 }}>Agent Dock's guard could not verify this action, so it waits for you instead of refusing it.</p>
      <ActionRequestCard key={first.request.id} projectId={first.project.id} project={first.project.name} request={first.request} />
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button className="btn ghost sm" onClick={close}>Later</button>
      </div>
    </Modal>
  );
}
