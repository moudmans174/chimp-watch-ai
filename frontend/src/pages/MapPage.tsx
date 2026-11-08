import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useApi } from "../lib/useApi";
import { fmtDate, num } from "../lib/format";
import { INDICATOR_ORDER, type Assessment, type Meta } from "../lib/types";
import MapView, { BASEMAPS, MapLegend, type Basemap, type MapHandle, type Pressure, type RecordDisplay } from "../components/MapView";
import { IndicatorStrip, LevelBadge, toast } from "../components/ui";

interface AreaSummary { observations: Record<string, number>; verified_species: number; latest_observation: string | null }
type Layers = { areas: boolean; chimps: boolean; wildlife: boolean; pressures: boolean };

const PERIODS: [string, string][] = [["90", "90 days"], ["365", "12 months"], ["1095", "3 years"], ["3650", "All"]];

function readPref<T>(key: string, fallback: T): T {
  try { const v = localStorage.getItem(key); return v ? (JSON.parse(v) as T) : fallback; } catch { return fallback; }
}
function writePref(key: string, v: unknown) { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* ignore */ } }

export default function MapPage() {
  const mapRef = useRef<MapHandle>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [layers, setLayers] = useState<Layers>(() => readPref("cw.map.layers", { areas: true, chimps: true, wildlife: false, pressures: true }));
  const [basemap, setBasemap] = useState<Basemap>(() => readPref("cw.map.basemap", "light"));
  const [display, setDisplay] = useState<RecordDisplay>(() => readPref("cw.map.display", "clusters"));
  const [period, setPeriod] = useState("365");
  const [selected, setSelected] = useState<number | null>(null);
  const [panelOpen, setPanelOpen] = useState(() => window.innerWidth > 900);
  const [search, setSearch] = useState("");
  const [isFull, setIsFull] = useState(false);

  useEffect(() => writePref("cw.map.layers", layers), [layers]);
  useEffect(() => writePref("cw.map.basemap", basemap), [basemap]);
  useEffect(() => writePref("cw.map.display", display), [display]);
  useEffect(() => {
    const h = () => setIsFull(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", h);
    return () => document.removeEventListener("fullscreenchange", h);
  }, []);

  const since = new Date(Date.now() - Number(period) * 86400000).toISOString().slice(0, 10);
  const areas = useApi<GeoJSON.FeatureCollection>("/areas.geojson");
  const obs = useApi<GeoJSON.FeatureCollection>(`/observations.geojson?status=verified&date_from=${since}&limit=20000`);
  const press = useApi<Pressure[]>(`/pressures?days=${period}`);
  const meta = useApi<Meta>("/meta");
  const latest = useApi<Assessment[]>("/analytics/latest");
  const summary = useApi<AreaSummary>(selected ? `/areas/${selected}/summary` : null);

  const counts = useMemo(() => {
    const f = obs.data?.features ?? [];
    const chimps = f.filter((x) => String(x.properties?.species).startsWith("Pan ")).length;
    return { chimps, wildlife: f.length - chimps, pressures: press.data?.length ?? 0, areas: areas.data?.features.length ?? 0 };
  }, [obs.data, press.data, areas.data]);

  const areaList = useMemo(() => (areas.data?.features ?? []).map((f) => f.properties as { id: number; name: string; designation: string; district: string; area_km2: number; risk_level: string | null })
    .sort((a, b) => a.name.localeCompare(b.name)), [areas.data]);
  const sel = areaList.find((a) => a.id === selected) ?? null;
  const ra = latest.data?.find((r) => r.area_id === selected) ?? null;
  const pressInSel = sel ? (press.data ?? []).filter((p) => p.area_name === sel.name).length : 0;

  const choose = (id: number) => { setSelected(id); mapRef.current?.zoomToArea(id); };
  const onSearch = (v: string) => {
    setSearch(v);
    const hit = areaList.find((a) => a.name.toLowerCase() === v.trim().toLowerCase());
    if (hit) { choose(hit.id); setSearch(""); }
  };
  const fullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else wrapRef.current?.requestFullscreen?.().catch(() => toast("Full screen isn't available in this browser"));
  };
  const t = (k: keyof Layers) => setLayers((l) => ({ ...l, [k]: !l[k] }));
  const loading = obs.loading || press.loading;

  return (
    <div className={`gis ${isFull ? "is-full" : ""}`} ref={wrapRef}>
      <div className="gis-toolbar" role="toolbar" aria-label="Map tools">
        <button className={`gis-btn ${panelOpen ? "on" : ""}`} onClick={() => setPanelOpen((o) => !o)} aria-pressed={panelOpen} title="Layers and basemaps">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5M3 17.5l9 5 9-5" /></svg><span>Layers</span>
        </button>
        <div className="gis-search">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></svg>
          <input list="cw-areas" placeholder="Find a landscape" value={search} onChange={(e) => onSearch(e.target.value)} aria-label="Find a landscape" />
          <datalist id="cw-areas">{areaList.map((a) => <option key={a.id} value={a.name} />)}</datalist>
        </div>
        <div className="segmented" role="group" aria-label="Time period">
          {PERIODS.map(([v, l]) => <button key={v} aria-pressed={period === v} onClick={() => setPeriod(v)}>{l}</button>)}
        </div>
        <div className="segmented" role="group" aria-label="Show records as">
          {(["clusters", "points", "heatmap"] as RecordDisplay[]).map((d) => (
            <button key={d} aria-pressed={display === d} onClick={() => setDisplay(d)}>{d === "clusters" ? "Clusters" : d === "points" ? "Points" : "Density"}</button>
          ))}
        </div>
        <div className="gis-actions">
          {loading && <span className="gis-loading" aria-live="polite">Loading…</span>}
          <button className="gis-btn icon" onClick={() => mapRef.current?.zoomToAll()} title="Zoom to all landscapes" aria-label="Zoom to all landscapes">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></svg></button>
          <button className="gis-btn icon" onClick={() => mapRef.current?.locate().catch((e) => toast(e.message))} title="Show my location" aria-label="Show my location">
            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3.5" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /><circle cx="12" cy="12" r="7.5" /></svg></button>
          <button className="gis-btn icon" onClick={fullscreen} title={isFull ? "Exit full screen" : "Full screen"} aria-label={isFull ? "Exit full screen" : "Full screen"}>
            <svg viewBox="0 0 24 24" aria-hidden="true">{isFull ? <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" /> : <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />}</svg></button>
        </div>
      </div>

      <div className="gis-body">
        {panelOpen && (
          <aside className="gis-panel gis-left" aria-label="Layers">
            <section>
              <h3>Layers</h3>
              <LayerRow on={layers.areas} onClick={() => t("areas")} label="Protected landscapes" count={counts.areas}
                swatch={<i className="sw-poly" />} />
              <LayerRow on={layers.chimps} onClick={() => t("chimps")} label="Chimpanzee records" count={counts.chimps}
                swatch={<i className="sw-dot" style={{ background: "var(--teal)" }} />} />
              <LayerRow on={layers.wildlife} onClick={() => t("wildlife")} label="Other wildlife" count={counts.wildlife}
                swatch={<i className="sw-dot" style={{ background: "var(--ink-2)" }} />} />
              <LayerRow on={layers.pressures} onClick={() => t("pressures")} label="Human pressure" count={counts.pressures}
                swatch={<i className="sw-tri" />} />
              <p className="xs muted" style={{ marginTop: 8 }}>Verified records from the selected period. Chimpanzee sites are generalised to ~{meta.data?.generalisation_km ?? 11} km unless your account has sensitive-location access.</p>
            </section>
            <section>
              <h3>Basemap</h3>
              <div className="basemaps">
                {(Object.keys(BASEMAPS) as Basemap[]).map((k) => (
                  <button key={k} className={`bm bm-${k} ${basemap === k ? "on" : ""}`} onClick={() => setBasemap(k)} aria-pressed={basemap === k}>
                    <span className="bm-thumb" aria-hidden="true" /><span>{BASEMAPS[k].label}</span>
                  </button>
                ))}
              </div>
            </section>
            <section>
              <h3>Legend</h3>
              <MapLegend generalisedKm={meta.data?.generalisation_km} compact />
            </section>
          </aside>
        )}

        <div className="gis-map">
          <MapView ref={mapRef} areas={areas.data} observations={obs.data} pressures={press.data} layers={layers}
            basemap={basemap} display={display} selectedAreaId={selected} onAreaClick={choose} showCoordinates />
          {!panelOpen && <div className="gis-mini-legend"><MapLegend generalisedKm={meta.data?.generalisation_km} compact /></div>}
        </div>

        {sel && (
          <aside className="gis-panel gis-right" aria-label={`${sel.name} details`}>
            <div className="spread" style={{ alignItems: "flex-start" }}>
              <div>
                <p className="xs muted">{sel.designation} · {sel.district} district</p>
                <h2 style={{ marginTop: 4 }}>{sel.name}</h2>
              </div>
              <button className="gis-btn icon" onClick={() => setSelected(null)} aria-label="Close details">✕</button>
            </div>
            <div className="row" style={{ marginTop: 10 }}><LevelBadge level={ra?.overall_level} /><span className="xs muted">{num(sel.area_km2)} km²</span></div>
            {ra && (
              <div style={{ marginTop: 14 }}>
                <IndicatorStrip large legend levels={Object.fromEntries(INDICATOR_ORDER.map((k) => [k, ra.components[k]?.level]))}
                  scores={Object.fromEntries(INDICATOR_ORDER.map((k) => [k, ra.components[k]?.score]))} />
              </div>
            )}
            <dl className="gis-stats">
              <div><dt>Verified records</dt><dd>{num(summary.data?.observations.verified ?? 0)}</dd></div>
              <div><dt>Awaiting validation</dt><dd>{num(summary.data?.observations.pending ?? 0)}</dd></div>
              <div><dt>Species recorded</dt><dd>{num(summary.data?.verified_species ?? 0)}</dd></div>
              <div><dt>Pressure reports</dt><dd>{num(pressInSel)}</dd></div>
            </dl>
            {ra && (
              <ul className="gis-drivers">
                {INDICATOR_ORDER.filter((k) => ra.components[k]?.level !== "low" && ra.components[k]?.score != null).slice(0, 3).map((k) => (
                  <li key={k}><b>{ra.components[k].label}:</b> {ra.components[k].drivers[0]}</li>
                ))}
              </ul>
            )}
            <p className="xs muted">Latest record {fmtDate(summary.data?.latest_observation)} · assessed {fmtDate(ra?.computed_at)}</p>
            <div className="stack" style={{ gap: 8, marginTop: 14 }}>
              <Link className="btn primary" to={`/areas/${sel.id}`}>Open landscape report</Link>
              <Link className="btn" to={`/alerts`}>View alerts</Link>
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}

function LayerRow({ on, onClick, label, count, swatch }: { on: boolean; onClick: () => void; label: string; count: number; swatch: React.ReactNode }) {
  return (
    <label className={`layer-row ${on ? "on" : ""}`}>
      <input type="checkbox" checked={on} onChange={onClick} />
      <span className="sw-wrap">{swatch}</span>
      <span className="layer-label">{label}</span>
      <span className="layer-count">{count.toLocaleString("en-GB")}</span>
    </label>
  );
}
