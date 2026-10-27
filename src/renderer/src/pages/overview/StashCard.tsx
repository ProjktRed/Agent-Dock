import { useEffect, useState } from "react";
import type { ProjectStatus, StashEntry } from "@shared/types";
import { cleanError, useApp } from "../../store";
import { Icon } from "../../components/Icon";

/** Stashes shown before "Show all". */
const SHOWN = 4;

const age = (at: string | null) => {
  if (!at) return "";
  const minutes = Math.round((Date.now() - Date.parse(at)) / 60_000);
  return minutes < 60 ? `${Math.max(minutes, 1)} min ago` : minutes < 48 * 60 ? `${Math.round(minutes / 60)} h ago` : new Date(at).toLocaleDateString();
};

/**
 * Overview › Workspace changes and stashes: Stash puts every uncommitted change in a named git stash (so a run that
 * needs a clean workspace can start), Pop puts a stash's work back. Both only while the engine is stopped.
 */
export function StashCard({ s, projectId }: { s: ProjectStatus; projectId: string }) {
  const { toast } = useApp();
  const [stashes, setStashes] = useState<StashEntry[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [showAll, setShowAll] = useState(false);
  // Collapsed by default: the summary line and Stash changes; the stash list opens with the button.
  const [open, setOpen] = useState(false);
  // Delete asks twice: the first click arms it for a few seconds.
  const [arming, setArming] = useState<string | null>(null);
  useEffect(() => {
    if (!arming) return;
    const t = setTimeout(() => setArming(null), 6000);
    return () => clearTimeout(t);
  }, [arming]);
  const changed = s.git.changedFiles.length;
  useEffect(() => {
    if (!s.git.isRepo) return;
    let live = true;
    window.api.stashes(projectId).then((list) => live && setStashes(list), () => live && setStashes([]));
    return () => { live = false; };
  }, [projectId, s.git.isRepo, s.git.head, changed, s.processAlive]);
  if (!s.git.isRepo || (!changed && !stashes?.length)) return null;

  const stopped = !s.processAlive;
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); } catch (error) { toast("error", cleanError(error)); } finally {
      setStashes(await window.api.stashes(projectId).catch(() => []));
      setBusy(false);
    }
  };
  const stash = () => act(async () => {
    const r = await window.api.stashChanges(projectId);
    toast("success", `${changed} change${changed === 1 ? "" : "s"} stashed as "${r.message}".`);
  });
  const pop = (entry: StashEntry) => act(async () => {
    const r = await window.api.popStash(projectId, entry.sha);
    if (r.conflicts) toast("warning", "The stash conflicts with the current files. Resolve the conflicted files yourself; the stash was kept.");
    else toast("success", `Popped "${entry.message}". Its work is back as uncommitted changes.`);
  });
  const drop = (entry: StashEntry) => act(async () => {
    setArming(null);
    await window.api.dropStash(projectId, entry.sha);
    toast("success", `Deleted the stash "${entry.message}".`);
  });
  const list = stashes ?? [];
  const shown = showAll ? list : list.slice(0, SHOWN);

  return (
    <section className="card pad stack" style={{ gap: 10 }} aria-label="Workspace changes and stashes">
      <div className="row wrap" style={{ gap: 12 }}>
        <div className="grow">
          <h2 className="h2">Workspace</h2>
          <div className="sub">
            {changed ? `${changed} uncommitted change${changed === 1 ? "" : "s"}` : "No uncommitted changes"}
            {list.length ? ` · ${list.length} stash${list.length === 1 ? "" : "es"}` : ""}
            {stopped ? "" : " · stop the automation to stash or pop"}
          </div>
        </div>
        {changed > 0 && (
          <button className="btn sm" disabled={busy || !stopped} onClick={() => void stash()} title={stopped ? "Put every uncommitted change, untracked files too, in a named git stash; nothing is deleted" : "Stop the automation first"}>
            Stash changes
          </button>
        )}
        {list.length > 0 && (
          <button className="btn ghost sm" onClick={() => setOpen(!open)} aria-expanded={open} aria-controls="stash-list">
            <Icon name={open ? "chevronDown" : "chevronRight"} size="sm" />{open ? "Hide stashes" : "Show stashes"}
          </button>
        )}
      </div>
      {open && list.length > 0 && (
        <ul className="tlist" id="stash-list">
          {shown.map((entry) => (
            <li key={entry.sha} className="item titem static">
              <div className="grow stack" style={{ gap: 2, minWidth: 0 }}>
                <span className="name ellipsis" title={entry.message}>{entry.message}</span>
                <span className="sub mono">{entry.ref} · {entry.sha.slice(0, 7)}{entry.at ? ` · ${age(entry.at)}` : ""}{entry.agentDock ? " · Agent Dock" : ""}</span>
              </div>
              <button className="btn sm" disabled={busy || !stopped || changed > 0} onClick={() => void pop(entry)} title={!stopped ? "Stop the automation first" : changed > 0 ? "Commit or stash the uncommitted changes first" : "Put this stash's work back as uncommitted changes and drop the stash"}>
                Pop
              </button>
              <button className={`btn sm ${arming === entry.sha ? "danger" : "ghost"}`} disabled={busy || !stopped} onClick={() => (arming === entry.sha ? void drop(entry) : setArming(entry.sha))} title={!stopped ? "Stop the automation first" : arming === entry.sha ? "Click again to delete this stash and its work" : "Delete this stash and its work (asks again)"}>
                {arming === entry.sha ? "Confirm delete" : "Delete"}
              </button>
            </li>
          ))}
        </ul>
      )}
      {open && list.length > SHOWN && (
        <button className="btn ghost sm" style={{ alignSelf: "flex-start" }} onClick={() => setShowAll(!showAll)} aria-expanded={showAll}>
          {showAll ? "Show fewer" : `Show all ${list.length}`}
        </button>
      )}
    </section>
  );
}
