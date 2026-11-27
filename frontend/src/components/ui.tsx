import { useEffect, useState, type ReactNode } from "react";
import { INDICATOR_ORDER, INDICATOR_SHORT, type Level } from "../lib/types";
import { humanize } from "../lib/format";

export function LevelBadge({ level }: { level: Level | null | undefined }) {
  if (!level) return <span className="level none">Not assessed</span>;
  return <span className={`level ${level}`}>{level === "high" ? "High" : level === "medium" ? "Medium" : "Low"}</span>;
}

export function StatusChip({ status }: { status: string }) {
  return <span className={`chip ${status}`}>{humanize(status)}</span>;
}

/** Five separate indicators, one cell each. The food-security cell is rendered as context (lighter). */
export function IndicatorStrip({ levels, large = false, legend = false, scores }: {
  levels: Record<string, string | null | undefined>; large?: boolean; legend?: boolean; scores?: Record<string, number | null>;
}) {
  const label = INDICATOR_ORDER.map((k) => `${INDICATOR_SHORT[k]}: ${levels[k] ?? "not assessed"}`).join(", ");
  return (
    <div>
      <div className={`strip ${large ? "lg" : ""}`} role="img" aria-label={label}>
        {INDICATOR_ORDER.map((k) => {
          const lv = levels[k];
          const s = scores?.[k];
          return (
            <span key={k} className={`${lv ?? ""} ${k === "food_security_vulnerability" ? "ctx" : ""}`}
              title={`${INDICATOR_SHORT[k]}: ${lv ?? "not assessed"}${s != null ? ` (${Math.round(s)}/100)` : ""}`} />
          );
        })}
      </div>
      {legend && <div className="strip-legend">{INDICATOR_ORDER.map((k) => <span key={k}>{INDICATOR_SHORT[k]}</span>)}</div>}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="empty"><b>{title}</b>{children}</div>;
}

export function ErrorBox({ error }: { error: { message: string } | null | undefined }) {
  if (!error) return null;
  return <div className="error-box" role="alert">{error.message}</div>;
}

export function Loading({ rows = 3 }: { rows?: number }) {
  return <div className="stack" style={{ padding: 20 }} aria-busy="true">{Array.from({ length: rows }, (_, i) => <div key={i} className="skeleton" style={{ width: `${90 - i * 15}%` }} />)}</div>;
}

let toastSetter: ((m: string | null) => void) | null = null;
export function toast(msg: string) { toastSetter?.(msg); }
export function ToastHost() {
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => { toastSetter = setMsg; return () => { toastSetter = null; }; }, []);
  useEffect(() => { if (!msg) return; const t = setTimeout(() => setMsg(null), 3200); return () => clearTimeout(t); }, [msg]);
  return msg ? <div className="toast" role="status">{msg}</div> : null;
}

export function Drawer({ title, onClose, children, actions }: { title: ReactNode; onClose: () => void; children: ReactNode; actions?: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <>
      <div className="drawer-back" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true">
        <div className="drawer-head">
          <div style={{ minWidth: 0 }}>{title}</div>
          <div className="row">{actions}<button className="btn ghost" onClick={onClose} aria-label="Close">✕</button></div>
        </div>
        <div className="drawer-body">{children}</div>
      </aside>
    </>
  );
}

const paths: Record<string, string> = {
  route: "M6 19a2 2 0 100-4 2 2 0 000 4zM18 9a2 2 0 100-4 2 2 0 000 4zM6 15V9a3 3 0 013-3h3M18 9v6a3 3 0 01-3 3h-3",
  camera: "M4 8h3l2-2.5h6L17 8h3v11H4zM12 16.5a3.5 3.5 0 100-7 3.5 3.5 0 000 7z",
  conflict: "M12 3c2 3 5 4.5 5 9a5 5 0 01-10 0c0-1.8.8-3 1.8-4 .2 1.6 1 2.6 2 3-.4-3 .2-5.5 1.2-8zM4 21h16",
  people: "M9 11a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM2.5 20c.6-3.4 3.2-5.5 6.5-5.5s5.9 2.1 6.5 5.5M16.5 11a3 3 0 100-6M18 14.7c2 .6 3.2 2.4 3.5 5.3",
  menu: "M4 7h16M4 12h16M4 17h16",
  satellite: "M13 7l4 4-6 6-4-4zM7 13l-3 3 4 4 3-3M15 5l2-2 4 4-2 2M17 13a4 4 0 01-4 4M20 13a7 7 0 01-7 7",
  tree: "M12 22v-6M12 16c-4 0-7-2.5-7-6a5 5 0 014-4.9A5 5 0 0117 7a4.5 4.5 0 012 8.6c-1.4.9-3.6.4-7 .4z",
  paw: "M8.5 11a2 2 0 100-4 2 2 0 000 4zM15.5 11a2 2 0 100-4 2 2 0 000 4zM5 15a1.8 1.8 0 100-3.6A1.8 1.8 0 005 15zM19 15a1.8 1.8 0 100-3.6A1.8 1.8 0 0019 15zM12 13c-3 0-5 3.2-5 5.2 0 1.6 1.3 2.3 2.6 2.3 1 0 1.6-.5 2.4-.5s1.4.5 2.4.5c1.3 0 2.6-.7 2.6-2.3 0-2-2-5.2-5-5.2z",
  axe: "M14 4l6 6-3 3-6-6zM11 7l-8 8 2 2 8-8M17 13c1.5 2 1.5 4 0 6",
  check: "M20 6L9 17l-5-5",
  dashboard: "M3 12l9-8 9 8M5 10v10h5v-6h4v6h5V10",
  map: "M9 4l-6 2v14l6-2 6 2 6-2V4l-6 2-6-2zM9 4v14M15 6v14",
  alert: "M12 3l10 18H2L12 3zM12 10v5M12 18v.5",
  obs: "M4 6h16M4 12h16M4 18h10",
  field: "M12 21s-7-6.2-7-11a7 7 0 1114 0c0 4.8-7 11-7 11zM12 12.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z",
  tasks: "M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2",
  eco: "M5 20c0-8 6-14 15-15-1 9-7 15-15 15zM5 20l7-7",
  report: "M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6",
  admin: "M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z",
};
export function Icon({ name }: { name: keyof typeof paths | string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={paths[name] || ""} />
    </svg>
  );
}
