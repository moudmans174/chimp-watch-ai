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
