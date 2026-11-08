import { Link, useNavigate } from "react-router-dom";
import { useApi } from "../lib/useApi";
import { fmtDate, num, relTime } from "../lib/format";
import type { Alert, Level } from "../lib/types";
import MapView, { MapLegend, type Pressure } from "../components/MapView";
import { BarChart } from "../components/charts";
import { Empty, ErrorBox, Icon, IndicatorStrip, LevelBadge, Loading } from "../components/ui";
import ForestScene from "../components/ForestScene";

interface Dash {
  observations: Record<string, number>;
  chimp_records_12m: number; chimp_records_prev_12m: number; verified_species: number;
  open_alerts: Record<string, number>;
  habitat: { forest_cover_km2: number; forest_loss_km2_latest: number; loss_rate_pct: number | null; mean_fragmentation: number | null; latest_period: string | null };
  pressures_90d: number; tasks_open: number; my_open_tasks: number;
  areas: { area_id: number; area: string; level: Level; computed_at: string; scores: Record<string, number | null>; levels: Record<string, Level> }[];
  monthly_chimp_records: { month: string; count: number }[];
  last_assessment: string | null;
}

const RANK: Record<Level, number> = { high: 0, medium: 1, low: 2 };

export default function Dashboard() {
  const nav = useNavigate();
  const { data, error, loading } = useApi<Dash>("/dashboard");
  const areas = useApi<GeoJSON.FeatureCollection>("/areas.geojson");
  const obs = useApi<GeoJSON.FeatureCollection>("/observations.geojson?species=Pan&status=verified&limit=3000");
  const press = useApi<Pressure[]>("/pressures?days=180");
  const alerts = useApi<{ items: Alert[] }>("/alerts?open_only=true&limit=5");

  if (error) return <ErrorBox error={error} />;
  if (loading || !data) return <Loading rows={6} />;

  const change = data.chimp_records_prev_12m ? (data.chimp_records_12m / data.chimp_records_prev_12m - 1) * 100 : null;
  const sorted = [...data.areas].sort((a, b) => RANK[a.level] - RANK[b.level] || (b.scores.population_concern ?? 0) - (a.scores.population_concern ?? 0));
  const highCount = data.areas.filter((a) => a.level === "high").length;

  return (
    <>
      <section className="dash-hero">
        <ForestScene variant="band" />
        <div className="dash-hero-inner">
          <div>
            <div className="eyebrow-loc"><Icon name="map" />Sierra Leone pilot · 6 protected landscapes</div>
            <h1>{highCount > 0 ? `${highCount} landscape${highCount > 1 ? "s" : ""} need urgent attention` : "No landscapes at high concern"}</h1>
            <p>Five separate indicators per landscape. Last assessed {relTime(data.last_assessment)}; modelled indicators are estimates with stated uncertainty.</p>
          </div>
          <div className="page-actions">
            <Link className="btn" to="/reports">Situation report</Link>
            <Link className="btn primary" to="/alerts">Review alerts</Link>
          </div>
        </div>
      </section>

      <section className="kpi-row" aria-label="Key indicators">
        <div className="kpi-card"><span className="ic chimp"><Icon name="paw" /></span><span className="v">{num(data.chimp_records_12m)}</span>
          <span className="l">Verified chimpanzee records, 12 months</span>
          <span className="d">{change === null ? "No prior year to compare" : `${change >= 0 ? "+" : ""}${change.toFixed(0)}% vs previous 12 months`}</span></div>
        <div className="kpi-card"><span className="ic forest"><Icon name="tree" /></span><span className="v">{num(data.habitat.forest_cover_km2)} km²</span>
          <span className="l">Forest cover in pilot areas</span>
          <span className="d">{num(data.habitat.forest_loss_km2_latest, 1)} km² lost in {data.habitat.latest_period?.slice(0, 4) ?? "—"} ({data.habitat.loss_rate_pct ?? "—"}%)</span></div>
        <div className="kpi-card"><span className="ic alert"><Icon name="alert" /></span><span className="v">{(data.open_alerts.high ?? 0) + (data.open_alerts.medium ?? 0)}</span>
          <span className="l">Open alerts</span><span className="d">{data.open_alerts.high ?? 0} high · {data.open_alerts.medium ?? 0} medium</span></div>
        <div className="kpi-card"><span className="ic press"><Icon name="axe" /></span><span className="v">{num(data.pressures_90d)}</span>
          <span className="l">Pressure reports, 90 days</span><span className="d">Mining, logging, snares, clearing</span></div>
        <div className="kpi-card"><span className="ic"><Icon name="check" /></span><span className="v">{num(data.observations.pending ?? 0)}</span>
          <span className="l">Records awaiting validation</span><span className="d">{data.tasks_open} field tasks open</span></div>
      </section>

      <div className="dash">
        <section className="panel dash-map" aria-label="Map of pilot landscapes">
          <MapView areas={areas.data} observations={obs.data} pressures={press.data} onAreaClick={(id) => nav(`/areas/${id}`)} />
          <MapLegend compact />
          <Link className="btn map-open" to="/map">Open full map</Link>
        </section>

        <div className="dash-side">
          <section className="panel">
            <div className="panel-head"><h2>Landscapes by concern</h2><span className="sub">Overall · 5 indicators</span></div>
            <div style={{ padding: "10px 20px 0" }}><IndicatorStrip levels={{}} legend /></div>
            <ul className="area-list">
              {sorted.map((a) => (
                <li key={a.area_id}>
                  <Link to={`/areas/${a.area_id}`}>
                    <span className="nm">{a.area}</span>
                    <LevelBadge level={a.level} />
                    <IndicatorStrip levels={a.levels} scores={a.scores} />
                  </Link>
                </li>
              ))}
            </ul>
          </section>

          <section className="panel">
            <div className="panel-head"><h2>Newest open alerts</h2><Link className="small" to="/alerts">All alerts</Link></div>
            {alerts.data?.items.length ? (
              <ul className="area-list">
                {alerts.data.items.map((a) => (
                  <li key={a.id}><Link to={`/alerts?id=${a.id}`}>
                    <span className="nm small">{a.title.replace(/^(High|Medium): /, "")}</span><LevelBadge level={a.level} />
                    <span className="xs muted" style={{ gridColumn: "1/-1" }}>{a.basis === "modelled" ? "Modelled risk" : "Observed change"} · {fmtDate(a.created_at)} · {a.status}</span>
                  </Link></li>
                ))}
              </ul>
            ) : <Empty title="No open alerts">Every alert has been reviewed.</Empty>}
          </section>
        </div>
      </div>

      <section className="panel" style={{ marginTop: 16 }}>
        <div className="panel-head"><h2>Verified chimpanzee records per month</h2><span className="sub">Raw counts, not adjusted for survey effort — see each landscape for encounter rates</span></div>
        <div className="panel-pad">
          {data.monthly_chimp_records.length
            ? <BarChart data={data.monthly_chimp_records.map((m) => ({ label: m.month, value: m.count }))} unit="verified records" />
            : <Empty title="No verified records in the last two years" />}
        </div>
      </section>
    </>
  );
}
