import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useApi } from "../lib/useApi";
import { fmtDate } from "../lib/format";
import type { Task } from "../lib/types";
import { Empty, ErrorBox, Loading, StatusChip, toast } from "../components/ui";

export default function Tasks() {
  const { user, can } = useAuth();
  const [mine, setMine] = useState(user?.role === "field_monitor");
  const list = useApi<Task[]>(`/tasks${mine ? "?mine=true" : ""}`);
  const open = list.data?.filter((t) => t.status === "open" || t.status === "in_progress") ?? [];
  const closed = list.data?.filter((t) => t.status === "done" || t.status === "cancelled") ?? [];

  return (
    <>
      <header className="page-head">
        <div><h1>Field tasks</h1><p>Verification visits and follow-up work raised from alerts. Record what you found before you close a task.</p></div>
        <div className="segmented" role="group" aria-label="Scope">
          <button aria-pressed={mine} onClick={() => setMine(true)}>Assigned to me</button>
          <button aria-pressed={!mine} onClick={() => setMine(false)}>All tasks</button>
        </div>
      </header>
      <ErrorBox error={list.error} />
      {list.loading && !list.data ? <Loading /> : (
        <div className="stack">
          {open.length ? open.map((t) => <TaskCard key={t.id} t={t} canEdit={can("analyst") || t.assigned_to === user?.id} onDone={list.reload} />)
            : <section className="panel"><Empty title={mine ? "Nothing assigned to you" : "No open tasks"}>New tasks appear here when an analyst assigns follow-up on an alert.</Empty></section>}
          {closed.length > 0 && (
            <section className="panel">
              <div className="panel-head"><h2>Completed</h2></div>
              <div className="table-wrap"><table className="data">
                <thead><tr><th>Task</th><th>Landscape</th><th>Assignee</th><th>Outcome</th><th>Closed</th></tr></thead>
                <tbody>{closed.map((t) => <tr key={t.id}><td>{t.title}</td><td>{t.area_name}</td><td>{t.assignee_name}</td><td>{t.outcome}</td><td>{fmtDate(t.completed_at)}</td></tr>)}</tbody>
              </table></div>
            </section>
          )}
        </div>
      )}
    </>
  );
}

function TaskCard({ t, canEdit, onDone }: { t: Task; canEdit: boolean; onDone: () => void }) {
  const [outcome, setOutcome] = useState(t.outcome ?? "");
  const [err, setErr] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const overdue = t.due_date && new Date(t.due_date) < new Date();
  const update = async (status: Task["status"]) => {
    setBusy(true); setErr(null);
    try {
      await api(`/tasks/${t.id}`, { method: "PATCH", json: { status, outcome: outcome || undefined } });
      toast(status === "done" ? "Task completed" : status === "in_progress" ? "Task started" : "Task updated");
      onDone();
    } catch (e) { setErr(e as Error); } finally { setBusy(false); }
  };
  return (
    <section className="panel panel-pad stack" style={{ gap: 10 }}>
      <div className="spread"><h2>{t.title}</h2><StatusChip status={t.status} /></div>
      <p className="small muted">{t.area_name} · {t.assignee_name ?? "Unassigned"} · due {fmtDate(t.due_date)}{overdue && <b style={{ color: "var(--high)" }}> (overdue)</b>}
        {t.alert_id && <> · <Link to={`/alerts?id=${t.alert_id}`}>View alert</Link></>}</p>
      {t.description && <p className="small">{t.description}</p>}
      {canEdit && (
        <>
          <label className="field">What did you find?<textarea className="input" value={outcome} onChange={(e) => setOutcome(e.target.value)} placeholder="Signs found, area covered, pressures seen" /></label>
          <ErrorBox error={err} />
          <div className="row">
            {t.status === "open" && <button className="btn" disabled={busy} onClick={() => update("in_progress")}>Start task</button>}
            <button className="btn primary" disabled={busy || !outcome.trim()} onClick={() => update("done")}>Complete task</button>
          </div>
        </>
      )}
    </section>
  );
}
