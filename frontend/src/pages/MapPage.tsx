import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useApi } from "../lib/useApi";
import type { Meta } from "../lib/types";
import MapView, { MapLegend, type MapLayers, type Pressure } from "../components/MapView";

export default function MapPage() {
  const nav = useNavigate();
  const [layers, setLayers] = useState<MapLayers>({ areas: true, chimps: true, wildlife: false, pressures: true, imagery: false });
  const [period, setPeriod] = useState("365");
  const since = new Date(Date.now() - Number(period) * 86400000).toISOString();
  const areas = useApi<GeoJSON.FeatureCollection>("/areas.geojson");
  const obs = useApi<GeoJSON.FeatureCollection>(`/observations.geojson?status=verified&date_from=${encodeURIComponent(since.slice(0, 10))}&limit=10000`);
  const press = useApi<Pressure[]>(`/pressures?days=${period}`);
  const meta = useApi<Meta>("/meta");
  const t = (k: keyof MapLayers) => setLayers((l) => ({ ...l, [k]: !l[k] }));

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Monitoring map</h1>
          <p>Verified records and pressure reports. Chimpanzee sites are generalised to ~{meta.data?.generalisation_km ?? 11} km unless your account has sensitive-location access.</p>
        </div>
        <div className="segmented" role="group" aria-label="Time period">
          {[["90", "90 days"], ["365", "12 months"], ["1095", "3 years"]].map(([v, l]) => (
            <button key={v} aria-pressed={period === v} onClick={() => setPeriod(v)}>{l}</button>
          ))}
        </div>
      </header>
      <section className="panel map-full">
        <MapView areas={areas.data} observations={obs.data} pressures={press.data} layers={layers} onAreaClick={(id) => nav(`/areas/${id}`)} />
        <div className="map-layers" role="group" aria-label="Layers">
          <label><input type="checkbox" checked={layers.areas} onChange={() => t("areas")} />Protected areas</label>
          <label><input type="checkbox" checked={layers.chimps} onChange={() => t("chimps")} />Chimpanzee records</label>
          <label><input type="checkbox" checked={layers.wildlife} onChange={() => t("wildlife")} />Other wildlife</label>
          <label><input type="checkbox" checked={layers.pressures} onChange={() => t("pressures")} />Pressure reports</label>
          <label><input type="checkbox" checked={layers.imagery} onChange={() => t("imagery")} />Satellite imagery</label>
        </div>
        <MapLegend generalisedKm={meta.data?.generalisation_km} />
      </section>
    </>
  );
}
