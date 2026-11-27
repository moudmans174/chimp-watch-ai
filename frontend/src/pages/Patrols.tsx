import { useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { useApi } from "../lib/useApi";
import { fmtDate, humanize, num } from "../lib/format";
import BarList from "../components/BarList";
import { Empty, ErrorBox, Loading } from "../components/ui";

interface Patrol {
  id: number; area_id: number | null; area_name: string | null; leader_name: string | null; team: string | null;
  purpose: string; started_at: string; ended_at: string; hours: number; distance_km: number; points: number; source: string; notes: string | null;
}
interface Summary { days: number; patrols: number; km: number; hours: number; by_area: { area_id: number | null; area_name: string; patrols: number; km: number; hours: number }[] }

export default function Patrols() {
  const { can } = useAuth();
  const [days, setDays] = useState(90);
  const [mine, setMine] = useState(false);
  const summary = useApi<Summary>(`/patrols/summary?days=${days}`);
  const list = useApi<Patrol[]>(`/patrols?days=${days}${mine ? "&mine=true" : ""}`);
  const s = summary.data;
  return (
    <>
      <header className="page-head">
        <div>
          <h1>Patrols</h1>
          <p>GPS-tracked foot patrols. Distance and hours per landscape show where monitoring effort is going, and where gaps are opening up.</p>
        </div>
        {can("field_monitor", "analyst") && <div className="page-actions"><Link className="btn primary" to="/capture?tab=patrol">Record a patrol</Link></div>}
      </header>
      <div className="filters">
        <div className="segmented" role="group" aria-label="Period">
          {[30, 90, 365].map((d) => <button key={d} aria-pressed={days === d} onClick={() => setDays(d)}>{d === 365 ? "12 months" : `${d} days`}</button>)}
        </div>
        <label className="row small" style={{ gap: 6 }}><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> Only my patrols</label>
      </div>
      <section className="stat-strip" aria-label="Patrol effort">
        <div><b>{num(s?.patrols)}</b><span>patrols</span></div>
        <div><b>{num(s?.km, 1)}</b><span>km walked</span></div>
        <div><b>{num(s?.hours, 1)}</b><span>hours in the field</span></div>
        <div><b>{s?.patrols ? num(s.km / s.patrols, 1) : "—"}</b><span>km per patrol</span></div>
      </section>
      <div className="two" style={{ alignItems: "start" }}>
        <section className="panel">
          <div className="panel-head"><h2>Recent patrols</h2></div>
          <ErrorBox error={list.error} />
          {!list.data ? <Loading /> : list.data.length ? (
            <div className="table-wrap"><table className="data">
              <thead><tr><th>Date</th><th>Landscape</th><th>Team</th><th>Purpose</th><th className="num">km</th><th className="num">Hours</th></tr></thead>
              <tbody>{list.data.slice(0, 200).map((p) => (
                <tr key={p.id}>
                  <td>{fmtDate(p.started_at)}<div className="xs muted">{p.source === "gpx" ? "Imported GPX" : p.source === "demo" ? "Demo data" : "Phone GPS"}</div></td>
                  <td>{p.area_name ?? <span className="muted">Outside pilot areas</span>}</td>
                  <td>{p.team || p.leader_name || "—"}</td>
                  <td>{humanize(p.purpose)}</td>
                  <td className="num">{num(p.distance_km, 1)}</td>
                  <td className="num">{num(p.hours, 1)}</td>
                </tr>
              ))}</tbody>
            </table></div>
          ) : <Empty title="No patrols in this period">Start a patrol from Add record, or import a GPX track from a handheld GPS.</Empty>}
        </section>
        <section className="panel panel-pad">
          <h2>Distance by landscape</h2>
          <p className="small muted" style={{ margin: "4px 0 12px" }}>Kilometres walked in the last {days === 365 ? "12 months" : `${days} days`}.</p>
          {s ? <BarList data={s.by_area.map((r) => [r.area_name, r.km] as [string, number])} label={(k) => k} unit=" km" /> : <Loading />}
          {can("analyst", "field_monitor") && <p className="xs muted" style={{ marginTop: 14 }}>Tracks are drawn on the Map under “Patrol tracks”. They're hidden from viewer accounts because they reveal ranger movements.</p>}
        </section>
      </div>
    </>
  );
}
