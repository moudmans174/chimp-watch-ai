import { useMemo } from "react";
import { useApi } from "../lib/useApi";
import { fmtDate, humanize, num } from "../lib/format";
import type { Area } from "../lib/types";
import { BarChart } from "../components/charts";
import { Empty, ErrorBox, Loading } from "../components/ui";
import ForestAlerts from "./ForestAlerts";
import { useSearchParams } from "react-router-dom";

interface Ind { id: number; category: string; indicator: string; district: string | null; area_id: number | null; period_start: string; value: number; unit: string | null; source: string; data_date: string | null }

const LABELS: Record<string, string> = {
  species_richness: "Camera-trap species richness", ndvi_anomaly: "Vegetation greenness anomaly",
  water_quality_index: "Water-quality index", soil_erosion_risk: "Soil-erosion risk", ipc_phase: "IPC food-insecurity phase",
  crop_vulnerability_index: "Crop vulnerability index", rainfall_anomaly_pct: "Seasonal rainfall anomaly",
};

export default function Ecosystem() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as "biodiversity" | "ecosystem" | "food" | "forest") || "biodiversity";
  const setTab = (t: string) => setParams({ tab: t }, { replace: true });
  const areas = useApi<Area[]>("/areas");
  const inds = useApi<Ind[]>("/indicators");
  const areaName = useMemo(() => Object.fromEntries((areas.data || []).map((a) => [a.id, a.name])), [areas.data]);

  if (inds.error) return <ErrorBox error={inds.error} />;
  if (!inds.data) return <Loading rows={6} />;

  const latestBy = (filter: (i: Ind) => boolean, key: (i: Ind) => string) => {
    const m = new Map<string, Ind>();
    inds.data!.filter(filter).forEach((i) => { const k = key(i); if (!m.has(k) || m.get(k)!.period_start < i.period_start) m.set(k, i); });
    return [...m.values()];
  };

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Ecosystem and food-security context</h1>
          <p>Biodiversity, ecosystem condition and district food-security indicators shown alongside chimpanzee monitoring. These are analysed separately; the platform tests for associations and does not claim that chimpanzee decline causes food insecurity.</p>
        </div>
      </header>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === "biodiversity"} onClick={() => setTab("biodiversity")}>Biodiversity</button>
        <button role="tab" aria-selected={tab === "ecosystem"} onClick={() => setTab("ecosystem")}>Ecosystem condition</button>
        <button role="tab" aria-selected={tab === "food"} onClick={() => setTab("food")}>Food security and climate</button>
        <button role="tab" aria-selected={tab === "forest"} onClick={() => setTab("forest")}>Forest alerts</button>
      </div>
      {tab === "forest" && <ForestAlerts />}

      {tab === "biodiversity" && (
        <div className="three">
          {(areas.data || []).map((a) => {
            const rows = inds.data!.filter((i) => i.indicator === "species_richness" && i.area_id === a.id);
            return (
              <section className="panel" key={a.id}>
                <div className="panel-head"><h3>{a.name}</h3></div>
                <div className="panel-pad">
                  {rows.length ? <BarChart height={150} data={rows.map((r) => ({ label: `${r.period_start.slice(2, 4)}Q${Math.floor(Number(r.period_start.slice(5, 7)) / 3) + 1}`, value: r.value }))} unit="species" />
                    : <Empty title="No camera-trap data" />}
                </div>
              </section>
            );
          })}
        </div>
      )}

      {tab === "ecosystem" && (
        <section className="panel">
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Landscape</th><th>Indicator</th><th className="num">Latest value</th><th>Period</th><th>Source</th></tr></thead>
            <tbody>{latestBy((i) => i.category === "ecosystem", (i) => `${i.area_id}-${i.indicator}`)
              .sort((x, y) => (areaName[x.area_id ?? 0] ?? "").localeCompare(areaName[y.area_id ?? 0] ?? "") || x.indicator.localeCompare(y.indicator))
              .map((i) => (
                <tr key={i.id}><td>{areaName[i.area_id ?? 0] ?? i.district}</td><td>{LABELS[i.indicator] ?? humanize(i.indicator)}</td>
                  <td className="num">{num(i.value, 2)} <span className="muted xs">{i.unit}</span></td><td>{fmtDate(i.period_start)}</td><td className="small muted">{i.source}</td></tr>
              ))}</tbody>
          </table></div>
        </section>
      )}

      {tab === "food" && (
        <section className="panel">
          <div className="note-box" style={{ margin: 16 }}>District-level context. Food security depends on climate, markets, productivity, infrastructure and livelihoods. Read these alongside, not as a consequence of, conservation indicators.</div>
          <div className="table-wrap"><table className="data">
            <thead><tr><th>District</th><th>Indicator</th><th className="num">Latest value</th><th>Period</th><th>Source</th></tr></thead>
            <tbody>{latestBy((i) => i.category === "food_security" || i.category === "climate", (i) => `${i.district}-${i.indicator}`)
              .sort((x, y) => (x.district ?? "").localeCompare(y.district ?? "") || x.indicator.localeCompare(y.indicator))
              .map((i) => (
                <tr key={i.id}><td>{i.district}</td><td>{LABELS[i.indicator] ?? humanize(i.indicator)}</td>
                  <td className="num">{num(i.value, 2)} <span className="muted xs">{i.unit}</span></td><td>{fmtDate(i.period_start)}</td><td className="small muted">{i.source}</td></tr>
              ))}</tbody>
          </table></div>
        </section>
      )}
    </>
  );
}
