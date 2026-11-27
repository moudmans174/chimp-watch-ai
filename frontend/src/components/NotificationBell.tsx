import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { relTime } from "../lib/format";

interface Note { id: number; kind: string; title: string; body: string | null; link: string | null; created_at: string; read: boolean }

const KIND_LABEL: Record<string, string> = {
  task: "Task", alert: "Alert", conflict: "Conflict", camera: "Camera traps", forest: "Satellite", access: "Access",
};

export default function NotificationBell() {
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<{ unread: number; items: Note[] }>({ unread: 0, items: [] });
  const ref = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    api<{ unread: number; items: Note[] }>("/notifications?limit=25").then(setData).catch(() => {});
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    return () => { clearInterval(t); window.removeEventListener("focus", onFocus); };
  }, [load]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [open]);

  const openItem = async (n: Note) => {
    if (!n.read) {
      setData((d) => ({ unread: Math.max(0, d.unread - 1), items: d.items.map((x) => (x.id === n.id ? { ...x, read: true } : x)) }));
      api(`/notifications/${n.id}/read`, { method: "POST" }).catch(() => {});
    }
    setOpen(false);
    if (n.link) nav(n.link);
  };
  const readAll = async () => {
    await api("/notifications/read-all", { method: "POST" }).catch(() => {});
    load();
  };

  return (
    <div className="bell" ref={ref}>
      <button className="bell-btn" onClick={() => { setOpen((o) => !o); if (!open) load(); }} aria-haspopup="true" aria-expanded={open}
        aria-label={data.unread ? `Notifications, ${data.unread} unread` : "Notifications"}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9a6 6 0 1112 0c0 4.5 1.8 6.3 2.5 7H3.5C4.2 15.3 6 13.5 6 9zM10 19.5a2 2 0 004 0" /></svg>
        {data.unread > 0 && <span className="bell-count">{data.unread > 99 ? "99+" : data.unread}</span>}
      </button>
      {open && (
        <div className="bell-panel" role="dialog" aria-label="Notifications">
          <div className="bell-head"><b>Notifications</b>{data.unread > 0 && <button className="btn ghost" onClick={readAll}>Mark all as read</button>}</div>
          {data.items.length ? (
            <ul>
              {data.items.map((n) => (
                <li key={n.id}>
                  <button className={`bell-item ${n.read ? "" : "unread"}`} onClick={() => openItem(n)}>
                    <span className={`bell-kind k-${n.kind}`}>{KIND_LABEL[n.kind] ?? n.kind}</span>
                    <span className="bell-title">{n.title}</span>
                    {n.body && <span className="bell-body">{n.body}</span>}
                    <span className="bell-time">{relTime(n.created_at)}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : <p className="bell-empty">You're all caught up. New tasks, alerts and reports will appear here.</p>}
        </div>
      )}
    </div>
  );
}
