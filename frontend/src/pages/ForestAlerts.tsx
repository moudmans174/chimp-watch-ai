import { useState } from "react";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useApi } from "../lib/useApi";
import { fmtDate, num, relTime } from "../lib/format";
import { BarChart } from "../components/charts";
import BarList from "../components/BarList";
import { Empty, ErrorBox, Loading, toast } from "../components/ui";

interface Status { configured: boolean; dataset: string; total_alerts: number; alerts_90d: number; last_sync: { at?: string; new_alerts?: number; hotspots?: number; errors?: string[] } | null }
interface Alerts { total: number; by_area: Record<string, number>; by_week: [string, number][]; items: { id: number; area_name: string | null; date: string; lat: number; lon: number; confidence: string | null; source: string }[] }

/** Satellite forest-disturbance alerts (Global Forest Watch integrated alerts) for the pilot landscapes. */
export default function ForestAlerts() {
  const { can } = useAuth();
  const [days, setDays] = useState(90);
  const status = useApi<Status>("/forest-alerts/status");
  const alerts = useApi<Alerts>(`/forest-alerts?days=${days}`);
  const [busy, setBusy] = useState(false);
  const [rows, setRows] = useState(15);
  const st = status.data;
  const sync = async () => {
    setBusy(true);
    try {
      const r = await api<{ new_alerts: number; hotspots: number }>("/forest-alerts/sync", { method: "POST" });
      toast(`${r.new_alerts} new alert pixels, ${r.hotspots} hotspots added as pressures`);
      status.reload(); alerts.reload();
    } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="stack">
      <section className="panel panel-pad">
        <div className="spread" style={{ alignItems: "start", gap: 16, flexWrap: "wrap" }}>
          <div style={{ maxWidth: "62ch" }}>
            <h2>Satellite forest alerts</h2>
            <p className="small" style={{ marginTop: 6 }}>
              Near-real-time tree-cover disturbance detected by satellite (Global Forest Watch integrated alerts, combining GLAD-L, GLAD-S2 and RADD).
              Clusters of alerts become <b>forest-loss</b> pressure reports, which feed the habitat-pressure indicator. An alert is a signal to check on the ground, not confirmed clearing.
            </p>
          </div>
          <div className="stack" style={{ gap: 6, minWidth: 220 }}>
            {!st ? <Loading rows={1} /> : st.configured
              ? <span className="chip verified">Connected to Global Forest Watch</span>
              : <span className="chip pending">Not connected: showing stored or demo alerts</span>}
            {st?.last_sync?.at && <span className="xs muted">Last checked {relTime(st.last_sync.at)}</span>}
            {can("analyst") && st?.configured && <button className="btn" disabled={busy} onClick={sync}>{busy ? "Checking…" : "Check for new alerts now"}</button>}
          </div>
        </div>
        {st && !st.configured && can("admin") && (
          <p className="xs muted" style={{ marginTop: 10 }}>To connect, get a free API key from Global Forest Watch and set <code>CW_GFW_API_KEY</code> in the server's .env, then restart. The worker checks daily.</p>
        )}
        {st?.last_sync?.errors?.length ? <div className="error-box" style={{ marginTop: 10 }}>Last check had problems: {st.last_sync.errors.slice(0, 2).join("; ")}</div> : null}
      </section>
      <div className="filters">
        <div className="segmented" role="group" aria-label="Period">
          {[30, 90, 365].map((d) => <button key={d} aria-pressed={days === d} onClick={() => setDays(d)}>{d === 365 ? "12 months" : `${d} days`}</button>)}
        </div>
        <span className="small muted">{num(alerts.data?.total)} alert pixels in this period</span>
      </div>
      <ErrorBox error={alerts.error} />
      {!alerts.data ? <Loading /> : alerts.data.total ? (
        <>
          <div className="two" style={{ alignItems: "start", gridTemplateColumns: "minmax(0,1.6fr) minmax(0,1fr)" }}>
            <section className="panel">
              <div className="panel-head"><h2>Alerts per week</h2></div>
              <div className="panel-pad"><BarChart tone="loss" unit="alert pixels" data={alerts.data.by_week.map(([w, n]) => ({ label: w, value: n }))} /></div>
            </section>
            <section className="panel panel-pad"><h2>By landscape</h2><div style={{ marginTop: 10 }}><BarList data={alerts.data.by_area} label={(k) => k} /></div></section>
          </div>
          <section className="panel">
            <div className="panel-head"><h2>Latest alerts</h2><span className="sub">Shown on the Map under “Forest alerts”</span></div>
            <div className="table-wrap"><table className="data">
              <thead><tr><th>Date</th><th>Landscape</th><th>Confidence</th><th>Position</th></tr></thead>
              <tbody>{alerts.data.items.slice(0, rows).map((a) => (
                <tr key={a.id}><td>{fmtDate(a.date)}</td><td>{a.area_name ?? "—"}</td>
                  <td><span className={`chip ${a.confidence === "highest" || a.confidence === "high" ? "high" : ""}`}>{a.confidence ?? "—"}</span>{a.source === "demo" && <span className="xs muted"> demo</span>}</td>
                  <td className="small">{a.lat.toFixed(4)}, {a.lon.toFixed(4)}</td></tr>
              ))}</tbody>
            </table></div>
            {alerts.data.items.length > rows && <div className="panel-pad"><button className="btn" onClick={() => setRows((r) => r + 50)}>Show more ({alerts.data.items.length - rows} remaining)</button></div>}
          </section>
        </>
      ) : <section className="panel"><Empty title="No forest alerts in this period">{st?.configured ? "No disturbance was detected in the pilot landscapes." : "Connect Global Forest Watch to receive alerts."}</Empty></section>}
    </div>
  );
}
