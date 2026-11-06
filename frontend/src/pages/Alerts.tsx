import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useApi } from "../lib/useApi";
import { CONFIDENCE_TEXT, fmtDate, humanize, relTime } from "../lib/format";
import { INDICATOR_SHORT, type Alert, type Area, type Task, type User } from "../lib/types";
import { Drawer, Empty, ErrorBox, LevelBadge, Loading, StatusChip, toast } from "../components/ui";

const NEXT: Record<Alert["status"], { to: Alert["status"]; label: string; needsNote?: boolean }[]> = {
  new: [{ to: "acknowledged", label: "Acknowledge" }, { to: "dismissed", label: "Dismiss", needsNote: true }],
  acknowledged: [{ to: "verified", label: "Mark verified", needsNote: true }, { to: "dismissed", label: "Dismiss", needsNote: true }],
  verifying: [{ to: "verified", label: "Mark verified", needsNote: true }, { to: "dismissed", label: "Dismiss", needsNote: true }],
  verified: [{ to: "resolved", label: "Mark resolved", needsNote: true }],
  dismissed: [{ to: "new", label: "Reopen" }],
  resolved: [],
};

export default function Alerts() {
  const [params, setParams] = useSearchParams();
  const [scope, setScope] = useState<"open" | "all">("open");
  const [level, setLevel] = useState("");
  const [areaId, setAreaId] = useState("");
  const q = new URLSearchParams({ limit: "200" });
  if (scope === "open") q.set("open_only", "true");
  if (level) q.set("level", level);
  if (areaId) q.set("area_id", areaId);
  const list = useApi<{ total: number; items: Alert[] }>(`/alerts?${q}`);
  const areas = useApi<Area[]>("/areas");
  const selected = params.get("id");

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Early-warning alerts</h1>
          <p>Each alert is raised for a single indicator in a single landscape. Modelled alerts are risk estimates, not confirmed changes, and every high alert needs a specialist to review it.</p>
        </div>
      </header>
      <div className="filters">
        <div className="segmented" role="group" aria-label="Scope">
          <button aria-pressed={scope === "open"} onClick={() => setScope("open")}>Open</button>
          <button aria-pressed={scope === "all"} onClick={() => setScope("all")}>All</button>
        </div>
        <select className="input" value={level} onChange={(e) => setLevel(e.target.value)} aria-label="Level">
          <option value="">All levels</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option>
        </select>
        <select className="input" value={areaId} onChange={(e) => setAreaId(e.target.value)} aria-label="Landscape">
          <option value="">All landscapes</option>{areas.data?.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      </div>
      <section className="panel">
        <ErrorBox error={list.error} />
        {list.loading && !list.data ? <Loading /> : list.data?.items.length ? (
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Level</th><th>Indicator</th><th>Landscape</th><th>Basis</th><th>Confidence</th><th>Status</th><th>Raised</th></tr></thead>
            <tbody>{list.data.items.map((a) => (
              <tr key={a.id} className="clickable" onClick={() => setParams({ id: String(a.id) })} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && setParams({ id: String(a.id) })}>
                <td><LevelBadge level={a.level} /></td>
                <td>{INDICATOR_SHORT[a.indicator] ?? a.indicator}</td>
                <td>{a.area_name}</td>
                <td>{a.basis === "modelled" ? "Modelled" : "Observed"}</td>
                <td>{CONFIDENCE_TEXT[a.confidence ?? ""] ?? "—"}</td>
                <td><StatusChip status={a.status} /></td>
                <td className="muted">{relTime(a.created_at)}</td>
              </tr>
            ))}</tbody>
          </table></div>
        ) : <Empty title={scope === "open" ? "No open alerts" : "No alerts match these filters"}>{scope === "open" ? "Every alert has been reviewed." : "Try clearing the filters."}</Empty>}
      </section>
      {selected && <AlertDrawer id={Number(selected)} onClose={() => setParams({})} onChange={list.reload} />}
    </>
  );
}

function AlertDrawer({ id, onClose, onChange }: { id: number; onClose: () => void; onChange: () => void }) {
  const { can } = useAuth();
  const al = useApi<Alert>(`/alerts/${id}`);
  const tasks = useApi<Task[]>(`/tasks?alert_id=${id}`);
  const users = useApi<User[]>("/users");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<Error | null>(null);
  const [taskTitle, setTaskTitle] = useState("");
  const [assignee, setAssignee] = useState("");
  const [due, setDue] = useState("");

  useEffect(() => { if (al.data) { setNotes(al.data.review_notes ?? ""); setTaskTitle(`Field verification: ${al.data.area_name}`); } }, [al.data]);

  const a = al.data;
  const act = async (to: Alert["status"], needsNote?: boolean) => {
    if (needsNote && !notes.trim()) { setErr(new Error("Add review notes explaining the decision first.")); return; }
    setBusy(true); setErr(null);
    try {
      await api(`/alerts/${id}`, { method: "PATCH", json: { status: to, review_notes: notes || undefined } });
      toast(`Alert ${humanize(to).toLowerCase()}`);
      await al.reload(); onChange();
    } catch (e) { setErr(e as Error); } finally { setBusy(false); }
  };
  const createTask = async () => {
    setBusy(true); setErr(null);
    try {
      await api("/tasks", { method: "POST", json: { alert_id: id, title: taskTitle, assigned_to: assignee ? Number(assignee) : null, due_date: due || null,
        description: a?.recommended_action } });
      toast("Field task assigned");
      await Promise.all([tasks.reload(), al.reload()]); onChange();
    } catch (e) { setErr(e as Error); } finally { setBusy(false); }
  };

  return (
    <Drawer onClose={onClose} title={a ? <><div className="row" style={{ marginBottom: 6 }}><LevelBadge level={a.level} /><StatusChip status={a.status} /></div><h2>{a.title.replace(/^(High|Medium|Low): /, "")}</h2></> : "Alert"}>
      {!a ? <Loading /> : (
        <>
          {a.basis === "modelled" && <div className="note-box">This is a modelled risk estimate, not a confirmed population count. Verify it in the field before acting on it.</div>}
          <p>{a.description.replace("[Modelled risk, not a confirmed population count] ", "")}</p>
          <dl className="kv">
            <dt>Recommended action</dt><dd>{a.recommended_action}</dd>
            <dt>Landscape</dt><dd><Link to={`/areas/${a.area_id}`}>{a.area_name}</Link></dd>
            <dt>Score</dt><dd>{a.score !== null ? `${Math.round(a.score)} / 100` : "—"}</dd>
            <dt>Confidence</dt><dd>{CONFIDENCE_TEXT[a.confidence ?? ""] ?? "—"}</dd>
            <dt>Input data as of</dt><dd>{fmtDate(a.data_as_of)}</dd>
            <dt>Model version</dt><dd>{a.model_version}</dd>
            <dt>Raised</dt><dd>{fmtDate(a.created_at, true)}</dd>
            {a.reviewed_at && <><dt>Reviewed</dt><dd>{fmtDate(a.reviewed_at, true)}</dd></>}
          </dl>
          {a.evidence?.caveat && <p className="small muted" style={{ fontStyle: "italic" }}>{a.evidence.caveat}</p>}
          {!!a.evidence?.history?.length && (
            <div><h3>Escalation history</h3><ul className="small">{a.evidence.history.map((h, i) => <li key={i}>{fmtDate(h.at, true)}: {h.from} → {h.to}</li>)}</ul></div>
          )}

          <div className="stack">
            <h3>Field tasks</h3>
            {tasks.data?.length ? tasks.data.map((t) => (
              <div key={t.id} className="small"><b>{t.title}</b> — {t.assignee_name ?? "unassigned"}, <StatusChip status={t.status} />{t.outcome && <div className="muted">Outcome: {t.outcome}</div>}</div>
            )) : <p className="small muted">No field tasks yet.</p>}
            {can("analyst") && !["resolved", "dismissed"].includes(a.status) && (
              <div className="stack" style={{ gap: 10 }}>
                <label className="field">Task<input className="input" value={taskTitle} onChange={(e) => setTaskTitle(e.target.value)} /></label>
                <div className="row" style={{ alignItems: "end" }}>
                  <label className="field" style={{ flex: 1 }}>Assign to
                    <select className="input" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
                      <option value="">Unassigned</option>{users.data?.filter((u) => u.role !== "viewer").map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
                    </select>
                  </label>
                  <label className="field">Due<input className="input" type="date" value={due} onChange={(e) => setDue(e.target.value)} /></label>
                </div>
                <button className="btn" onClick={createTask} disabled={busy || taskTitle.length < 3}>Assign field task</button>
              </div>
            )}
          </div>

          {can("analyst") && (
            <div className="stack" style={{ gap: 10 }}>
              <h3>Review</h3>
              <label className="field">Review notes <span className="hint">Required to verify, dismiss or resolve</span>
                <textarea className="input" value={notes} onChange={(e) => setNotes(e.target.value)} />
              </label>
              <ErrorBox error={err} />
              <div className="row">
                {NEXT[a.status].filter((n) => n.to !== "new" || can()).map((n) => (
                  <button key={n.to} className={`btn ${n.to === "dismissed" ? "danger" : n.to === "verified" || n.to === "resolved" ? "primary" : ""}`} disabled={busy} onClick={() => act(n.to, n.needsNote)}>{n.label}</button>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </Drawer>
  );
}
