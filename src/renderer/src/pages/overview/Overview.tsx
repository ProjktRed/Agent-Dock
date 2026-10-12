import { useState } from "react";
import { useApp } from "../../store";
import { runTone, roleLabel } from "../../lib/format";
import { Icon } from "../../components/Icon";
import { RunControls } from "../../components/Shell";
import { Empty, Tabs } from "../../components/ui";
import { ProgressTab } from "./ProgressTab";
import { UsageTab } from "./UsageTab";
import { TokensTab } from "./TokensTab";

type Tab = "progress" | "usage" | "tokens";

export function OverviewPage() {
  const { activeProject, activeStatus, snap, go } = useApp();
  const [tab, setTab] = useState<Tab>("progress");

  if (!activeProject) {
    return (
      <Empty title={snap.projects.length ? "No active project" : "No projects yet"} icon="folder">
        <span>{snap.projects.length ? "Choose a project to monitor." : "Register a workspace to start automating."}</span>
        <button className="btn primary" onClick={() => go("projects")}>
          <Icon name="plus" size="sm" />
          {snap.projects.length ? "Open projects" : "Add project"}
        </button>
      </Empty>
    );
  }

  const s = activeStatus;
  const tone = s ? runTone[s.runState] : runTone.idle;
  const stageText = s?.cycle ? roleLabel[s.cycle === "next" ? "assessment" : s.cycle] ?? s.cycle : s?.stage && s.stage !== "waiting" ? s.stage : "—";

  return (
    <>
      <section className="well pad" aria-label="Automation summary" style={{ display: "flex", alignItems: "center", gap: 28, flexWrap: "wrap" }}>
        <div style={{ minWidth: 180 }}>
          <div className="eyebrow">Selected project</div>
          <h1 className="h1">{activeProject.name}</h1>
        </div>
        <dl className="kv grow" style={{ minWidth: 420 }}>
          <div>
            <dt>Current task</dt>
            <dd title={s?.task?.name}>{s?.task ? `${s.task.id} · ${s.task.name}` : "None"}</dd>
          </div>
          <div>
            <dt>Automation</dt>
            <dd className={tone.text}>{s?.label ?? "Loading…"}</dd>
          </div>
          <div>
            <dt>Current agent</dt>
            <dd>{s?.activeRole ? `${s.activeRole}${s.activeModel ? ` · ${s.activeModel}` : ""}` : "—"}</dd>
          </div>
          <div>
            <dt>Workflow stage</dt>
            <dd>{stageText}</dd>
          </div>
        </dl>
        <RunControls status={s} projectId={activeProject.id} size="" />
      </section>

      <Tabs<Tab>
        label="Overview sections"
        value={tab}
        onChange={setTab}
        options={[
          { value: "progress", label: "Progress" },
          { value: "usage", label: "Usage limits" },
          { value: "tokens", label: "Token consumption" },
        ]}
      />
      <div className="fade-in" key={tab}>
        {tab === "progress" && <ProgressTab />}
        {tab === "usage" && <UsageTab />}
        {tab === "tokens" && <TokensTab />}
      </div>
    </>
  );
}
