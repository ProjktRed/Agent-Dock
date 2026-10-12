import { useEffect, useState } from "react";
import type { UpdateStatus } from "@shared/types";
import { cleanError, useApp } from "../store";
import { ago } from "../lib/format";
import { Icon } from "../components/Icon";
import { Disclosure, SetRow, Spinner, St, Toggle } from "../components/ui";

export function useUpdateStatus() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  useEffect(() => {
    void window.api.updateStatus().then(setStatus);
    return window.api.onUpdate(setStatus);
  }, []);
  return status;
}

export function Updates() {
  const { snap, saveSettings, toast } = useApp();
  const u = snap.settings.updates;
  const status = useUpdateStatus();
  const [source, setSource] = useState(u.source);
  const [branch, setBranch] = useState(u.branch);
  const patch = (next: Partial<typeof u>) => saveSettings({ ...snap.settings, updates: { ...u, ...next } });
  if (!status) return <div className="skel" style={{ width: "40%" }} />;
  const dev = status.state === "dev";
  const busy = status.state === "checking" || status.state === "building" || status.state === "ready";

  return (
    <div className="stack" style={{ gap: 20 }}>
      <section className="card pad stack" style={{ gap: 14 }}>
        <div className="row wrap" style={{ gap: 12 }}>
          <div className="grow">
            <h2 className="h2">Installed version</h2>
            {status.installed ? (
              <div className="sub">
                <span className="mono">{status.installed.shortCommit}</span> · {status.installed.subject} · built {ago(status.installed.builtAt)} from <span className="mono">{status.installed.branch}</span>
              </div>
            ) : (
              <div className="sub">Development build. Updates apply to the installed app (npm run release:local).</div>
            )}
          </div>
          <button className="btn" disabled={dev || busy} onClick={() => window.api.checkForUpdates().catch((e) => toast("error", cleanError(e)))}>
            {status.state === "checking" ? <Spinner /> : <Icon name="refresh" size="sm" />}Check now
          </button>
        </div>
        {status.state === "up-to-date" && <div className="row ok"><St kind="done" />Up to date with {status.branch} · checked {ago(status.checkedAt)}</div>}
        {status.state === "error" && <div className="banner errb"><Icon name="warn" className="err" /><span>{status.error}</span></div>}
        {(status.state === "available" || status.state === "building" || status.state === "ready") && status.latest && (
          <div className="well pad stack fade-in" style={{ gap: 10 }}>
            <div className="row">
              <St kind={status.state === "available" ? "attn" : "active"} />
              <b style={{ fontWeight: 600 }} className="grow">
                {status.state === "available" ? `Update available: ${status.commits.length || "new"} commit${status.commits.length === 1 ? "" : "s"}` : status.state === "ready" ? "Built. Restarting to finish the update…" : "Building the new version…"}
              </b>
              {status.state === "available" && (
                <button className="btn primary sm" onClick={() => window.api.applyUpdate().catch((e) => toast("error", cleanError(e)))}>Update now</button>
              )}
            </div>
            <ul className="list">
              {status.commits.slice(0, 12).map((c) => (
                <li key={c.hash} className="commit">
                  <div className="row" style={{ gap: 10 }}><span className="mono mut">{c.hash.slice(0, 7)}</span><b className="grow ellipsis" style={{ fontWeight: 600 }}>{c.subject}</b><span className="sub">{ago(c.date)}</span></div>
                  {c.body && <div className="changelog selectable">{c.body}</div>}
                </li>
              ))}
            </ul>
            <span className="hint">The app keeps running while the new version builds from a clean copy of the committed code, then restarts. Running automation must be stopped first.</span>
          </div>
        )}
        {status.log.length > 0 && (
          <Disclosure title="Update log" meta={`${status.log.length} lines`} defaultOpen={status.state === "building" || status.state === "error"}>
            <div className="mono log selectable">{status.log.join("\n")}</div>
          </Disclosure>
        )}
      </section>

      <section className="card pad">
        <h2 className="h2" style={{ marginBottom: 4 }}>Automatic updates</h2>
        <SetRow title="Check for updates on launch" desc="Compares the installed commit with the source branch" support="app"><Toggle on={u.autoCheck} onChange={(v) => patch({ autoCheck: v })} label="Check on launch" /></SetRow>
        <SetRow title="Check while running" desc="Asks the source for a newer commit in the background and when you return to the window (at most every 10 minutes). Free: no download unless there is an update." support="app">
          <select className="sel" value={u.checkMinutes} disabled={!u.autoCheck} onChange={(e) => patch({ checkMinutes: Number(e.target.value) })} aria-label="Background update check interval">
            {[0, 15, 30, 60, 180].map((m) => <option key={m} value={m}>{m === 0 ? "Off (launch only)" : m < 60 ? `Every ${m} min` : `Every ${m / 60} h`}</option>)}
          </select>
        </SetRow>
        <SetRow title="Install without asking" desc="Builds and restarts automatically when no automation is running; otherwise asks" support="app"><Toggle on={u.autoInstall} onChange={(v) => patch({ autoInstall: v })} label="Install automatically" disabled={!u.autoCheck} /></SetRow>
        <SetRow title="Update source" desc={`A GitHub URL (https://github.com/owner/repo.git) or a local repository path. Empty uses ${status.installed?.source || "the build's source"}.`} support="app">
          <input className="input mono" style={{ width: 300 }} value={source} placeholder={status.installed?.source ?? "https://github.com/owner/repo.git"} onChange={(e) => setSource(e.target.value)} onBlur={() => source !== u.source && patch({ source: source.trim() })} aria-label="Update source" />
        </SetRow>
        <SetRow title="Branch" desc="Only committed history on this branch is used" support="app">
          <input className="input mono" style={{ width: 160 }} value={branch} placeholder={status.installed?.branch ?? "master"} onChange={(e) => setBranch(e.target.value)} onBlur={() => branch !== u.branch && patch({ branch: branch.trim() })} aria-label="Update branch" />
        </SetRow>
      </section>
    </div>
  );
}
