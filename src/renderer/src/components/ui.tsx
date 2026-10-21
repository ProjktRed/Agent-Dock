import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Provenance } from "@shared/types";
import { Icon } from "./Icon";

export function Toggle({ on, onChange, label, disabled, danger }: { on: boolean; onChange?: (next: boolean) => void; label: string; disabled?: boolean; danger?: boolean }) {
  return <button className={`tg ${on ? "on" : ""} ${danger ? "danger" : ""}`} role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onChange?.(!on)} />;
}

type SegOption<T extends string> = { value: T; label: ReactNode; disabled?: boolean; title?: string };

/**
 * The one joined segmented control: a sunken group whose chosen segment gets the accent fill.
 * `radio` gives it radio-group semantics (a setting such as Theme or Task size) instead of tabs (switching views).
 * Each label sits on a hidden bold copy so segments keep their width when they turn bold.
 */
export function Tabs<T extends string>({ value, options, onChange, small, label, radio }: { value: T; options: SegOption<T>[]; onChange: (v: T) => void; small?: boolean; label: string; radio?: boolean }) {
  return (
    <div className="tabs" role={radio ? "radiogroup" : "tablist"} aria-label={label}>
      {options.map((o) => (
        <button key={o.value} className={`tab ${small ? "sm" : ""} ${value === o.value ? "on" : ""}`} role={radio ? "radio" : "tab"} aria-selected={radio ? undefined : value === o.value} aria-checked={radio ? value === o.value : undefined} disabled={o.disabled} title={o.title} onClick={() => onChange(o.value)}>
          <span className="tl"><span>{o.label}</span><span className="tl-w" aria-hidden="true">{o.label}</span></span>
        </button>
      ))}
    </div>
  );
}

/** A segmented setting: Tabs with radio semantics, same look. */
export function Segmented<T extends string>(props: { value: T; options: SegOption<T>[]; onChange: (v: T) => void; small?: boolean; label: string }) {
  return <Tabs {...props} radio />;
}

export type StatusKind = "done" | "active" | "paused" | "pending" | "blocked" | "part" | "attn";
export function St({ kind, title }: { kind: StatusKind; title?: string }) {
  return <span className={`st ${kind}`} title={title ?? kind} role="img" aria-label={title ?? kind} />;
}

export function Dot({ tone, live }: { tone: string; live?: boolean }) {
  return <span className={`dot ${tone} ${live ? "live" : ""}`} />;
}

/** Progress bar. Plan and phase progress always use the default (accent) fill; est and man mark estimated and manual usage. */
export function Bar({ pct, variant = "", large }: { pct: number; variant?: "" | "est" | "man"; large?: boolean }) {
  return (
    <div className={`bar ${variant} ${large ? "lg" : ""}`} role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
      <i style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
    </div>
  );
}

const provenanceMeta: Record<Provenance, { label: string; cls: string }> = {
  reported: { label: "Reported", cls: "info" },
  estimated: { label: "Estimated", cls: "lav dash" },
  manual: { label: "Manual", cls: "warn" },
  "not-exposed": { label: "Not exposed", cls: "mut dash" },
  unavailable: { label: "Unavailable", cls: "mut dash" },
  "not-applicable": { label: "Not applicable", cls: "mut dash" },
};
export function ProvenanceChip({ value, small = true }: { value: Provenance; small?: boolean }) {
  const meta = provenanceMeta[value];
  return (
    <span className={`chip ${meta.cls}`} style={small ? { height: 18, fontSize: 10.5 } : undefined}>
      {meta.label}
    </span>
  );
}

/** Marks how a setting takes effect, so nothing implies enforcement that doesn't exist. */
export function Support({ kind }: { kind: "engine" | "app" | "saved" }) {
  const meta = {
    engine: ["ok", "Enforced by engine", "Passed to the automation engine when it starts"],
    app: ["info", "Applied by app", "The desktop app enforces this itself"],
    saved: ["mut", "Saved only", "Stored for later; the current engine does not read it yet"],
  }[kind];
  return (
    <span className={`support ${meta[0]}`} title={meta[2]}>
      <span className="dot" />
      {meta[1]}
    </span>
  );
}

export function Modal({ title, onClose, children, wide, label }: { title?: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>("input, textarea, select, button")?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      prev?.focus();
    };
  }, [onClose]);
  return (
    <div className="modal-back" role="dialog" aria-modal="true" aria-label={label} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal fade-in ${wide ? "wide" : ""}`} ref={ref}>
        {title && (
          <div className="row">
            <h2 className="h2 grow" style={{ fontSize: 17 }}>
              {title}
            </h2>
            <button className="btn ghost icon" onClick={onClose} aria-label="Close">
              <Icon name="close" />
            </button>
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

export function Empty({ icon = "folder", title, children }: { icon?: Parameters<typeof Icon>[0]["name"]; title: string; children?: ReactNode }) {
  return (
    <div className="well empty">
      <Icon name={icon} size="lg" />
      <span style={{ color: "var(--t)", fontWeight: 600 }}>{title}</span>
      {children}
    </div>
  );
}

export function Disclosure({ title, meta, children, defaultOpen = false }: { title: ReactNode; meta?: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button className="disc" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon name="chevronRight" size="sm" className={`chev ${open ? "open" : ""}`} />
        {title}
        <span className="grow" />
        {meta && <span className="sub">{meta}</span>}
      </button>
      {open && <div className="fade-in">{children}</div>}
    </div>
  );
}

export function SetRow({ title, desc, children, support }: { title: ReactNode; desc?: ReactNode; children: ReactNode; support?: "engine" | "app" | "saved" }) {
  return (
    <div className="setrow">
      <div className="grow">
        <div className="lt row" style={{ gap: 8 }}>
          {title}
          {support && <Support kind={support} />}
        </div>
        {desc && <div className="ld">{desc}</div>}
      </div>
      <div className="ctl">{children}</div>
    </div>
  );
}

export function Spinner() {
  return <span className="spin" aria-label="Working" />;
}
