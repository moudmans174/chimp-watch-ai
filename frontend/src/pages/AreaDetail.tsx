import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useApi } from "../lib/useApi";
import { CONFIDENCE_TEXT, fmtDate, num } from "../lib/format";
import { INDICATOR_ORDER, type Area, type Assessment } from "../lib/types";
import MapView, { type Pressure } from "../components/MapView";
import { BarChart, TrendChart } from "../components/charts";
import { Empty, ErrorBox, IndicatorStrip, LevelBadge, Loading, toast } from "../components/ui";

interface Threshold { indicator: string; medium: number; high: number; enabled: boolean }
interface Habitat { period_start: string; forest_cover_km2: number; forest_loss_km2: number; fragmentation_index: number | null; source: string }
interface Report { narrative: string[]; open_alerts: { id: number; title: string; level: "low" | "medium" | "high"; status: string }[] }

export default function AreaDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const area = useApi<Area>(`/areas/${id}`);
  const ras = useApi<Assessment[]>(`/areas/${id}/assessments?limit=1`);
  const hab = useApi<Habitat[]>(`/areas/${id}/habitat`);
  const th = useApi<Threshold[]>("/thresholds");
  const report = useApi<Report>(`/reports/area/${id}`);
  const areasGeo = useApi<GeoJSON.FeatureCollection>("/areas.geojson");
  const obs = useApi<GeoJSON.FeatureCollection>(`/observations.geojson?area_id=${id}&status=verified&limit=4000`);
  const press = useApi<Pressure[]>(`/pressures?area_id=${id}&days=365`);
  const [running, setRunning] = useState(false);

  if (area.error) return <ErrorBox error={area.error} />;
  if (!area.data || ras.loading) return <Loading rows={6} />;
  const a = area.data;
  const ra = ras.data?.[0];
  const thMap = Object.fromEntries((th.data || []).map((t) => [t.indicator, t]));

  const rerun = async () => {
    setRunning(true);
    try {
      const r = await api<{ alerts_created_or_escalated: number }>(`/analytics/run?area_id=${id}`, { method: "POST" });
      toast(`Assessment updated. ${r.alerts_created_or_escalated} alert${r.alerts_created_or_escalated === 1 ? "" : "s"} raised or escalated.`);
      await Promise.all([ras.reload(), report.reload(), areasGeo.reload()]);
    } catch (e) { toast((e as Error).message); } finally { setRunning(false); }
  };

  return (
    <>
      <header className="page-head">
        <div>
          <p className="small" style={{ marginTop: 0 }}><Link to="/">Overview</Link> / {a.district} district</p>
          <h1 style={{ marginTop: 4 }}>{a.name}</h1>
          <p>{a.designation} · {num(a.area_km2)} km² · {a.boundary_source}</p>
        </div>
        <div className="page-actions">
          <LevelBadge level={ra?.overall_level} />
          {can("analyst") && <button className="btn" onClick={rerun} disabled={running}>{running ? "Running…" : "Run assessment now"}</button>}
        </div>
      </header>

      {ra && (
        <section className="panel panel-pad" style={{ marginBottom: 16 }}>
          <IndicatorStrip large legend levels={Object.fromEntries(INDICATOR_ORDER.map((k) => [k, ra.components[k]?.level]))}
            scores={Object.fromEntries(INDICATOR_ORDER.map((k) => [k, ra.components[k]?.score]))} />
          <p className="xs muted" style={{ marginTop: 10 }}>Model {ra.model_version} · computed {fmtDate(ra.computed_at, true)} · latest input data {fmtDate(ra.data_as_of)}. Overall level is high only when several conservation indicators are elevated; food security is shown as context and excluded from it.</p>
        </section>
      )}

      <div className="two">
        <div className="stack">
          <section className="panel">
            <div className="panel-head"><h2>Chimpanzee encounter rate</h2><span className="sub">{ra?.forecast?.method ?? "Verified sign records per km of survey effort"}</span></div>
            <div className="panel-pad">
              {ra?.forecast?.series?.length
                ? <TrendChart series={ra.forecast.series} fitted={ra.forecast.fitted} forecast={ra.forecast.points} />
                : <Empty title="No surveyed quarters yet">Record survey effort with transect or recce data to start a time series.</Empty>}
              <p className="xs muted" style={{ marginTop: 10 }}>An index of relative abundance, not a population count. Quarters with no survey effort are left out, not treated as zero.</p>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head"><h2>Indicator breakdown</h2><span className="sub">Score 0–100, higher means more concern</span></div>
            {ra ? INDICATOR_ORDER.map((k) => {
              const c = ra.components[k];
              if (!c) return null;
              const t = thMap[k];
              const color = c.level === "high" ? "var(--high)" : c.level === "medium" ? "var(--medium)" : "var(--low)";
              return (
                <div className="comp" key={k}>
                  <h3>{c.label}</h3>
                  <LevelBadge level={c.score === null ? null : c.level} />
                  <div className="meter" aria-hidden="true">
                    {c.score !== null && <b style={{ width: `${c.score}%`, background: color }} />}
                    {t && <><i style={{ left: `${t.medium}%` }} /><i style={{ left: `${t.high}%` }} /></>}
                  </div>
                  <div className="meta">
                    {c.score === null ? "Not scored" : `Score ${Math.round(c.score)}`} · {c.basis === "modelled" ? "Modelled estimate" : "Observed data"} · {CONFIDENCE_TEXT[c.confidence] ?? c.confidence} · data {fmtDate(c.data_as_of)}
                    {t && ` · thresholds ${t.medium} / ${t.high}`}
                  </div>
                  <ul>{c.drivers.map((d, i) => <li key={i}>{d}</li>)}</ul>
                  {c.caveat && <div className="meta" style={{ fontStyle: "italic" }}>{c.caveat}</div>}
                </div>
              );
            }) : <Empty title="Not yet assessed">{can("analyst") ? "Run an assessment to compute indicators." : "An analyst needs to run the first assessment."}</Empty>}
          </section>
        </div>

        <div className="stack">
          <section className="panel" style={{ height: 340, position: "relative", overflow: "hidden" }}>
            <MapView areas={areasGeo.data} observations={obs.data} pressures={press.data} focusAreaId={Number(id)} />
          </section>
          <section className="panel">
            <div className="panel-head"><h2>Annual forest loss</h2><span className="sub">{hab.data?.[0]?.source}</span></div>
            <div className="panel-pad">
              {hab.data?.length
                ? <BarChart tone="loss" data={hab.data.map((h) => ({ label: h.period_start.slice(0, 4), value: h.forest_loss_km2 }))} unit="km² lost" height={170} />
                : <Empty title="No land-cover data">Import habitat metrics from Reports → Import data.</Empty>}
            </div>
          </section>
          <section className="panel">
            <div className="panel-head"><h2>Summary</h2></div>
            <div className="panel-pad narrative small">{report.data?.narrative.map((l, i) => <p key={i}>{l}</p>)}</div>
          </section>
          <section className="panel">
            <div className="panel-head"><h2>Open alerts here</h2></div>
            {report.data?.open_alerts.length ? (
              <ul className="area-list">{report.data.open_alerts.map((al) => (
                <li key={al.id}><Link to={`/alerts?id=${al.id}`}><span className="small">{al.title.replace(/ — .*/, "")}</span><LevelBadge level={al.level} /></Link></li>
              ))}</ul>
            ) : <Empty title="No open alerts for this landscape" />}
          </section>
        </div>
      </div>
    </>
  );
}
