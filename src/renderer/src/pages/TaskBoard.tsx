import { useEffect, useState, type DragEvent, type KeyboardEvent, type ReactNode } from "react";
import type { PlanItemKey, TaskBoard, TaskBoardActivity, TaskBoardItem, TaskBoardUpdate } from "@shared/types";
import { boardOrder, columnItems, plannedView, reorderWithin, withOrder } from "@shared/task-board";
import { cleanError, useApp } from "../store";
import { Icon } from "../components/Icon";
import { Dot, Empty, Segmented } from "../components/ui";

/** Finished items shown before "Show all". */
const FINISHED_SHOWN = 8;

type Grouping = "phase" | "flat";

function activityText(a: TaskBoardActivity): string {
  if (a.kind === "current") return `${a.taskId} · ${a.name}`;
  if (a.kind === "parallel") return `Parallel · ${a.taskId}${a.detail ? ` (${a.detail})` : ""}`;
  if (a.kind === "step-down") return `Step-down redo · ${a.taskId}`;
  return `Deferred · ${a.taskId}`;
}

function PhaseChip({ item }: { item: TaskBoardItem }) {
  return <span className="chip mut" title={`Phase ${item.phase.number} · ${item.phase.title}`}>Phase {item.phase.number}</span>;
}

function ItemBadges({ item }: { item: TaskBoardItem }) {
  const deferred = item.activity.find((a) => a.kind === "deferred");
  return (
    <>
      {deferred && <span className="chip warn" title={deferred.detail ? `Set aside: ${deferred.detail}` : "Set aside: Assessment passes over it while other work remains"}>Deferred</span>}
      {item.ambiguous && <span className="chip dash attn" title="This title appears on more than one plan line, so the engine cannot check it off by its text. Make the titles distinct.">Duplicate title</span>}
    </>
  );
}

/** One Planned item: draggable within its view, with keyboard-reachable move buttons. */
function PlannedRow(props: {
  item: TaskBoardItem;
  index: number;
  count: number;
  rank: number;
  flat: boolean;
  selected: boolean;
  dropBefore: boolean;
  dropAfter: boolean;
  busy: boolean;
  onSelect: () => void;
  onMove: (to: number) => void;
  onDragStart: (e: DragEvent) => void;
  onDragOver: (e: DragEvent) => void;
  onDrop: (e: DragEvent) => void;
  onDragEnd: () => void;
}) {
  const { item, index, count, flat } = props;
  const scope = flat ? "the list" : "its phase";
  const onKey = (e: KeyboardEvent) => {
    if (e.target !== e.currentTarget || !e.altKey) return;
    if (e.key === "ArrowUp" && index > 0) { e.preventDefault(); props.onMove(index - 1); }
    if (e.key === "ArrowDown" && index < count - 1) { e.preventDefault(); props.onMove(index + 1); }
  };
  return (
    <li
      className={`item titem ${props.selected ? "on" : ""} ${props.dropBefore ? "drop-before" : ""} ${props.dropAfter ? "drop-after" : ""}`}
      draggable={!props.busy}
      tabIndex={0}
      aria-label={`${item.title}, priority ${props.rank + 1}. Alt+Up or Alt+Down moves it within ${scope}.`}
      onClick={props.onSelect}
      onKeyDown={onKey}
      onDragStart={props.onDragStart}
      onDragOver={props.onDragOver}
      onDrop={props.onDrop}
      onDragEnd={props.onDragEnd}
    >
      <Icon name="grip" size="sm" className="mut grip" />
      <span className="mono mut rank">{props.rank + 1}</span>
      <div className="grow stack" style={{ gap: 4, paddingLeft: item.depth * 14 }}>
        <span className="name">{item.title}</span>
        {(flat || item.activity.length > 0 || item.ambiguous) && (
          <span className="row wrap" style={{ gap: 6 }}>
            {flat && <PhaseChip item={item} />}
            <ItemBadges item={item} />
          </span>
        )}
      </div>
      <span className="row tmoves" style={{ gap: 2 }} onClick={(e) => e.stopPropagation()}>
        <button className="btn ghost sm icon" disabled={props.busy || index === 0} onClick={() => props.onMove(0)} title={`Move to top of ${scope}`} aria-label={`Move ${item.title} to top of ${scope}`}><Icon name="toTop" size="sm" /></button>
        <button className="btn ghost sm icon" disabled={props.busy || index === 0} onClick={() => props.onMove(index - 1)} title="Move up" aria-label={`Move ${item.title} up`}><Icon name="arrowUp" size="sm" /></button>
        <button className="btn ghost sm icon" disabled={props.busy || index === count - 1} onClick={() => props.onMove(index + 1)} title="Move down" aria-label={`Move ${item.title} down`}><Icon name="arrowDown" size="sm" /></button>
      </span>
    </li>
  );
}

function Column({ title, count, children, label }: { title: string; count: number; children: ReactNode; label: string }) {
  return (
    <section className="card tcol" aria-label={label}>
      <div className="row tcol-h">
        <h2 className="h2">{title}</h2>
        <span className="chip raised mono" aria-label={`${count} items`}>{count}</span>
      </div>
      {children}
    </section>
  );
}

export function TaskBoardPage() {
  const { activeProject, activeStatus: s, snap, go, toast } = useApp();
  const [local, setLocal] = useState<TaskBoard | null>(null);
  const [optimistic, setOptimistic] = useState<{ base: number; order: PlanItemKey[]; groupByPhase?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<PlanItemKey | null>(null);
  const [drag, setDrag] = useState<{ id: PlanItemKey; scope: number | null } | null>(null);
  const [over, setOver] = useState<{ id: PlanItemKey; after: boolean } | null>(null);
  const [showAll, setShowAll] = useState(false);
  const projectId = activeProject?.id ?? null;
  useEffect(() => { setLocal(null); setOptimistic(null); setSelected(null); }, [projectId]);
  // Older status (another build, or a status pushed before this page's write landed): fetch the board once.
  useEffect(() => {
    if (!projectId || !s || s.board) return;
    let live = true;
    window.api.taskBoard(projectId).then((b) => live && setLocal(b), () => {});
    return () => { live = false; };
  }, [projectId, s, s?.board]);

  if (!activeProject) {
    return (
      <Empty title={snap.projects.length ? "No active project" : "No projects yet"} icon="board">
        <span>{snap.projects.length ? "Choose a project to see its tasks." : "Register a workspace to plan its tasks."}</span>
        <button className="btn primary" onClick={() => go("projects")}><Icon name="plus" size="sm" />{snap.projects.length ? "Open projects" : "Add project"}</button>
      </Empty>
    );
  }
  if (!s) return <div className="well pad stack" style={{ gap: 12 }}><div className="skel" style={{ width: "40%" }} /><div className="skel" style={{ width: "80%" }} /></div>;

  // The newest board: the one a write returned until polling catches up, with a reorder being saved shown at once.
  const base = local && (!s.board || local.revision > s.board.revision) ? local : s.board ?? local;
  const shown = base && optimistic && optimistic.base === base.revision ? withOrder(base, optimistic.order) : base;
  const groupByPhase = optimistic?.groupByPhase ?? shown?.groupByPhase ?? true;

  if (!shown || shown.items.length === 0) {
    return (
      <Empty title="No plan tasks" icon="board">
        <span>{s.plan.error ?? "IMPLEMENTATION_PLAN.md has no checklist items yet."} Tasks appear here from its <span className="mono">## Phase N</span> checkboxes.</span>
      </Empty>
    );
  }
  const board = shown;
  const planned = columnItems(board, "planned");
  const working = columnItems(board, "in-progress");
  const finished = columnItems(board, "finished");
  const flat = !groupByPhase;

  const save = async (update: Omit<TaskBoardUpdate, "expectedRevision">, order?: PlanItemKey[]) => {
    setBusy(true);
    if (order) setOptimistic({ base: board.revision, order });
    try {
      const result = await window.api.setTaskBoard(activeProject.id, { ...update, expectedRevision: board.revision });
      setLocal(result.board);
      if (!result.ok) toast("warning", "The task list changed meanwhile. It is refreshed; make the change again.");
    } catch (error) {
      toast("error", cleanError(error));
    } finally {
      setOptimistic(null);
      setBusy(false);
    }
  };
  const move = (view: PlanItemKey[], from: number, to: number) => {
    const order = reorderWithin(boardOrder(board), view, from, to);
    if (order.join() !== boardOrder(board).join()) void save({ order }, order);
  };
  const setGrouping = (g: Grouping) => {
    setOptimistic({ base: board.revision, order: boardOrder(board), groupByPhase: g === "phase" });
    void save({ groupByPhase: g === "phase" });
  };

  const renderList = (scope: number | null) => {
    const view = plannedView(board, scope);
    const items = view.map((id) => planned.find((i) => i.id === id)!);
    const onDrop = (e: DragEvent, target: number, after: boolean) => {
      e.preventDefault();
      if (!drag || drag.scope !== scope) return;
      const from = view.indexOf(drag.id);
      let to = target + (after ? 1 : 0);
      if (from < to) to--;
      setDrag(null);
      setOver(null);
      if (from >= 0) move(view, from, to);
    };
    return (
      <ol className="tlist" aria-label={scope === null ? "Planned tasks by priority" : `Phase ${scope} planned tasks by priority`}>
        {items.map((item, index) => (
          <PlannedRow
            key={item.id}
            item={item}
            index={index}
            count={items.length}
            rank={item.priority ?? 0}
            flat={flat}
            selected={selected === item.id}
            busy={busy}
            dropBefore={over?.id === item.id && !over.after && drag?.id !== item.id}
            dropAfter={over?.id === item.id && over.after && drag?.id !== item.id}
            onSelect={() => setSelected(selected === item.id ? null : item.id)}
            onMove={(to) => move(view, index, to)}
            onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", item.id); setDrag({ id: item.id, scope }); }}
            onDragOver={(e) => {
              if (!drag || drag.scope !== scope) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              const rect = e.currentTarget.getBoundingClientRect();
              const after = e.clientY > rect.top + rect.height / 2;
              if (over?.id !== item.id || over.after !== after) setOver({ id: item.id, after });
            }}
            onDrop={(e) => onDrop(e, index, over?.id === item.id ? over.after : false)}
            onDragEnd={() => { setDrag(null); setOver(null); }}
          />
        ))}
      </ol>
    );
  };

  const phases = [...new Map(planned.map((i) => [i.phase.number, i.phase])).values()].sort((a, b) => a.number - b.number);
  const finishedShown = showAll ? finished : finished.slice(0, FINISHED_SHOWN);

  return (
    <div className="stack" style={{ gap: 20 }}>
      <section className="well pad row wrap" style={{ gap: 16 }} aria-label="Task board">
        <div className="grow" style={{ minWidth: 260 }}>
          <h1 className="h1">Tasks</h1>
          <div className="sub">Assessment takes the highest Planned task it can do next. Changes apply at the next Assessment; a running task keeps going.</div>
        </div>
        <Segmented<Grouping> label="Group tasks" small value={groupByPhase ? "phase" : "flat"} onChange={setGrouping} options={[{ value: "phase", label: "By phase" }, { value: "flat", label: "One list" }]} />
        <button className="btn sm" disabled={busy || !planned.length} onClick={() => void save({ reset: true }, [])} title="Forget the custom order and follow IMPLEMENTATION_PLAN.md order">
          <Icon name="refresh" size="sm" />Reset to plan order
        </button>
      </section>

      <div className="tcols">
        <Column title="Planned" count={planned.length} label="Planned tasks">
          {!planned.length && <div className="sub tcol-e">Nothing planned: every open task is in progress or done.</div>}
          {flat
            ? planned.length > 0 && renderList(null)
            : phases.map((p) => (
                <div key={p.number} className="tphase">
                  <div className="row tphase-h">
                    <span className="eyebrow grow ellipsis" title={p.title}>Phase {p.number} · {p.title}</span>
                    <span className="sub mono">{planned.filter((i) => i.phase.number === p.number).length}</span>
                  </div>
                  {renderList(p.number)}
                </div>
              ))}
        </Column>

        <Column title="In progress" count={working.length} label="Tasks in progress">
          {!working.length && <div className="sub tcol-e">{s.processAlive ? "Assessment is choosing the next task." : "Nothing is being worked on."}</div>}
          <ul className="tlist">
            {working.map((item) => (
              <li key={item.id} className="item titem static">
                <Dot tone="ok" live />
                <div className="grow stack" style={{ gap: 4 }}>
                  <span className="name">{item.title}</span>
                  <span className="row wrap" style={{ gap: 6 }}>
                    <PhaseChip item={item} />
                    {item.activity.filter((a) => a.kind !== "deferred").map((a) => (
                      <span key={`${a.kind}:${a.taskId}`} className={`chip ${a.kind === "parallel" ? "lav" : a.kind === "step-down" ? "warn" : "info"}`} title={a.name}>{activityText(a)}</span>
                    ))}
                    <ItemBadges item={item} />
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </Column>

        <Column title="Finished" count={finished.length} label="Finished tasks">
          {!finished.length && <div className="sub tcol-e">No task is checked off yet.</div>}
          <ul className="tlist">
            {finishedShown.map((item) => (
              <li key={item.id} className="item titem static done">
                <Icon name="check" size="sm" className="ok" />
                <div className="grow stack" style={{ gap: 4 }}>
                  <span className="name">{item.title}</span>
                  <span className="row wrap" style={{ gap: 6 }}><PhaseChip item={item} /></span>
                </div>
              </li>
            ))}
          </ul>
          {finished.length > FINISHED_SHOWN && (
            <button className="btn ghost sm" style={{ alignSelf: "flex-start" }} onClick={() => setShowAll(!showAll)} aria-expanded={showAll}>
              {showAll ? "Show fewer" : `Show all ${finished.length}`}
            </button>
          )}
        </Column>
      </div>
    </div>
  );
}
