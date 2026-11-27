import { useState, type FormEvent } from "react";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useApi } from "../lib/useApi";
import { fmtDate, humanize, num } from "../lib/format";
import type { Area, Meta } from "../lib/types";
import BarList from "../components/BarList";
import { Drawer, Empty, ErrorBox, Loading, toast } from "../components/ui";

interface Activity {
  id: number; area_id: number | null; area_name: string | null; community: string; kind: string; held_on: string;
  participants: number; women: number | null; youth: number | null; facilitator: string | null; summary: string;
  follow_up: string | null; follow_up_due: string | null; follow_up_done: boolean; source: string; created_by: number | null;
}
interface Summary { activities: number; participants: number; women: number; youth: number; communities: number; open_follow_ups: number; by_kind: Record<string, number> }

export default function Community() {
  const { can, user } = useAuth();
  const [view, setView] = useState<"all" | "follow">("all");
  const [kind, setKind] = useState("");
  const [adding, setAdding] = useState(false);
  const [sel, setSel] = useState<Activity | null>(null);
  const meta = useApi<Meta>("/meta");
  const q = new URLSearchParams({ days: "730" });
  if (kind) q.set("kind", kind);
  if (view === "follow") q.set("open_follow_ups", "true");
  const list = useApi<Activity[]>(`/outreach?${q}`);
  const summary = useApi<Summary>("/outreach/summary");
  const s = summary.data;
  const reload = () => { list.reload(); summary.reload(); };
  const today = new Date().toISOString().slice(0, 10);
  return (
    <>
      <header className="page-head">
        <div>
          <h1>Community</h1>
          <p>Meetings, school visits, training and agreements with the communities that share the forest. Follow-ups keep promises from slipping.</p>
        </div>
        {can("field_monitor", "analyst") && <div className="page-actions"><button className="btn primary" onClick={() => setAdding(true)}>Log an activity</button></div>}
      </header>
      <section className="stat-strip" aria-label="Outreach in the last 12 months">
        <div><b>{num(s?.activities)}</b><span>activities, 12 months</span></div>
        <div><b>{num(s?.participants)}</b><span>participants</span></div>
        <div><b>{s?.participants ? `${Math.round((s.women / s.participants) * 100)}%` : "—"}</b><span>women</span></div>
        <div><b>{s?.participants ? `${Math.round((s.youth / s.participants) * 100)}%` : "—"}</b><span>youth</span></div>
        <div><b>{num(s?.communities)}</b><span>communities reached</span></div>
      </section>
      <div className="filters">
        <div className="segmented" role="group" aria-label="Show">
          <button aria-pressed={view === "all"} onClick={() => setView("all")}>All activities</button>
          <button aria-pressed={view === "follow"} onClick={() => setView("follow")}>Open follow-ups{s?.open_follow_ups ? ` (${s.open_follow_ups})` : ""}</button>
        </div>
        <select className="input" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Type">
          <option value="">All types</option>{(meta.data?.outreach_kinds ?? []).map((k) => <option key={k} value={k}>{humanize(k)}</option>)}
        </select>
      </div>
      <div className="two" style={{ alignItems: "start", gridTemplateColumns: "minmax(0,1.7fr) minmax(0,1fr)" }}>
        <section className="panel">
          <ErrorBox error={list.error} />
          {!list.data ? <Loading /> : list.data.length ? (
            <div className="table-wrap"><table className="data">
              <thead><tr><th>Date</th><th>Community</th><th>Activity</th><th className="num">People</th><th>Follow-up</th></tr></thead>
              <tbody>{list.data.map((a) => (
                <tr key={a.id} className="clickable" tabIndex={0} onClick={() => setSel(a)} onKeyDown={(e) => e.key === "Enter" && setSel(a)}>
                  <td>{fmtDate(a.held_on)}</td>
                  <td>{a.community}<div className="xs muted">{a.area_name ?? ""}</div></td>
                  <td>{humanize(a.kind)}</td>
                  <td className="num">{a.participants}</td>
                  <td>{!a.follow_up ? <span className="muted">—</span> : a.follow_up_done ? <span className="chip verified">Done</span>
                    : <span className={`chip ${a.follow_up_due && a.follow_up_due < today ? "high" : ""}`}>{a.follow_up_due ? `Due ${fmtDate(a.follow_up_due)}` : "Open"}</span>}</td>
                </tr>
              ))}</tbody>
            </table></div>
          ) : <Empty title={view === "follow" ? "No open follow-ups" : "No activities logged"}>{view === "follow" ? "Every promised follow-up has been done." : "Log a meeting, school visit or training to start the record."}</Empty>}
        </section>
        <section className="panel panel-pad"><h2>Activity types</h2><p className="small muted" style={{ margin: "4px 0 12px" }}>Last 12 months.</p>{s ? <BarList data={s.by_kind} /> : <Loading />}</section>
      </div>
      {adding && <AddActivity kinds={meta.data?.outreach_kinds ?? []} onClose={() => setAdding(false)} onDone={() => { setAdding(false); reload(); }} />}
      {sel && (
        <Drawer title={<><p className="xs muted">{fmtDate(sel.held_on)} · {sel.area_name ?? "No landscape"}</p><h2>{humanize(sel.kind)} in {sel.community}</h2></>} onClose={() => setSel(null)}>
          <dl className="kv">
            <dt>Participants</dt><dd>{sel.participants}{sel.women != null ? `, ${sel.women} women` : ""}{sel.youth != null ? `, ${sel.youth} youth` : ""}</dd>
            <dt>Facilitator</dt><dd>{sel.facilitator ?? "—"}</dd>
            <dt>Summary</dt><dd>{sel.summary}</dd>
            {sel.follow_up && <><dt>Follow-up</dt><dd>{sel.follow_up}{sel.follow_up_due ? ` (due ${fmtDate(sel.follow_up_due)})` : ""}</dd></>}
          </dl>
          {sel.follow_up && !sel.follow_up_done && (can("analyst") || sel.created_by === user?.id) && (
            <button className="btn primary" onClick={async () => {
              try { await api(`/outreach/${sel.id}`, { method: "PATCH", json: { follow_up_done: true } }); toast("Follow-up marked done"); setSel(null); reload(); }
              catch (e) { toast((e as Error).message); }
            }}>Mark follow-up done</button>
          )}
        </Drawer>
      )}
    </>
  );
}

function AddActivity({ kinds, onClose, onDone }: { kinds: string[]; onClose: () => void; onDone: () => void }) {
  const areas = useApi<Area[]>("/areas");
  const today = new Date().toISOString().slice(0, 10);
  const [f, setF] = useState({ community: "", kind: "meeting", held_on: today, area_id: "", participants: "", women: "", youth: "", facilitator: "", summary: "", follow_up: "", follow_up_due: "" });
  const [err, setErr] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const n = (v: string) => (v === "" ? null : Number(v));
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr(null); setBusy(true);
    try {
      await api("/outreach", { method: "POST", json: {
        client_uuid: crypto.randomUUID(), community: f.community, kind: f.kind, held_on: f.held_on, area_id: n(f.area_id),
        participants: Number(f.participants), women: n(f.women), youth: n(f.youth), facilitator: f.facilitator || null,
        summary: f.summary, follow_up: f.follow_up || null, follow_up_due: f.follow_up_due || null,
      } });
      toast("Activity logged"); onDone();
    } catch (ex) { setErr(ex as Error); } finally { setBusy(false); }
  };
  return (
    <Drawer title={<h2>Log a community activity</h2>} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <div className="row" style={{ alignItems: "end" }}>
          <label className="field" style={{ flex: 1 }}>Community<input className="input" required minLength={2} value={f.community} onChange={set("community")} /></label>
          <label className="field">Date<input className="input" type="date" max={today} required value={f.held_on} onChange={set("held_on")} /></label>
        </div>
        <div className="row" style={{ alignItems: "end" }}>
          <label className="field" style={{ flex: 1 }}>Type<select className="input" value={f.kind} onChange={set("kind")}>{kinds.map((k) => <option key={k} value={k}>{humanize(k)}</option>)}</select></label>
          <label className="field" style={{ flex: 1 }}>Landscape<select className="input" value={f.area_id} onChange={set("area_id")}><option value="">Not linked</option>{(areas.data ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
        </div>
        <div className="row" style={{ alignItems: "end" }}>
          <label className="field">Participants<input className="input" type="number" min={0} required value={f.participants} onChange={set("participants")} /></label>
          <label className="field">Women <span className="hint">Optional</span><input className="input" type="number" min={0} value={f.women} onChange={set("women")} /></label>
          <label className="field">Youth <span className="hint">Optional</span><input className="input" type="number" min={0} value={f.youth} onChange={set("youth")} /></label>
        </div>
        <label className="field">Facilitator <span className="hint">Optional</span><input className="input" value={f.facilitator} onChange={set("facilitator")} /></label>
        <label className="field">What happened<textarea className="input" required minLength={5} value={f.summary} onChange={set("summary")} placeholder="Topics covered, concerns raised, decisions made" /></label>
        <label className="field">Follow-up promised <span className="hint">Optional</span><input className="input" value={f.follow_up} onChange={set("follow_up")} placeholder="e.g. Return with seedlings for the buffer zone" /></label>
        {f.follow_up && <label className="field">Follow-up due<input className="input" type="date" value={f.follow_up_due} onChange={set("follow_up_due")} /></label>}
        <ErrorBox error={err} />
        <button className="btn primary" disabled={busy}>{busy ? "Saving…" : "Log activity"}</button>
      </form>
    </Drawer>
  );
}
