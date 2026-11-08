import { useEffect, useState } from "react";
import { api, download, getToken } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useApi } from "../lib/useApi";
import { fmtDate, humanize } from "../lib/format";
import type { Area, Observation } from "../lib/types";
import { Drawer, Empty, ErrorBox, Loading, StatusChip, toast } from "../components/ui";

const PAGE = 50;

type Tab = "obs" | "pressures" | "surveys";

export default function Records() {
  const [tab, setTab] = useState<Tab>(() => (new URLSearchParams(window.location.search).get("tab") as Tab) || "obs");
  return (
    <>
      <header className="page-head">
        <div>
          <h1>All records</h1>
          <p>Everything collected in the field, from camera traps and imports. Only verified records feed the indicators and trends.</p>
        </div>
      </header>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === "obs"} onClick={() => setTab("obs")}>Wildlife observations</button>
        <button role="tab" aria-selected={tab === "pressures"} onClick={() => setTab("pressures")}>Pressure reports</button>
        <button role="tab" aria-selected={tab === "surveys"} onClick={() => setTab("surveys")}>Surveys</button>
      </div>
      {tab === "obs" ? <ObservationsTab /> : tab === "pressures" ? <PressuresTab /> : <SurveysTab />}
    </>
  );
}

function ObservationsTab() {
  const { can } = useAuth();
  const [status, setStatus] = useState("");
  const [areaId, setAreaId] = useState("");
  const [species, setSpecies] = useState("");
  const [mine, setMine] = useState(false);
  const [offset, setOffset] = useState(0);
  const [sel, setSel] = useState<Observation | null>(null);
  const q = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
  if (status) q.set("status", status);
  if (areaId) q.set("area_id", areaId);
  if (species) q.set("species", species);
  if (mine) q.set("mine", "true");
  const list = useApi<{ total: number; items: Observation[] }>(`/observations?${q}`);
  const areas = useApi<Area[]>("/areas");
  useEffect(() => setOffset(0), [status, areaId, species, mine]);

  return (
    <>
      <div className="filters">
        <select className="input" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Validation status">
          <option value="">Any status</option><option value="pending">Awaiting validation</option><option value="verified">Verified</option><option value="rejected">Rejected</option>
        </select>
        <select className="input" value={areaId} onChange={(e) => setAreaId(e.target.value)} aria-label="Landscape">
          <option value="">All landscapes</option>{areas.data?.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <input className="input" placeholder="Species name" value={species} onChange={(e) => setSpecies(e.target.value)} aria-label="Species" />
        <label className="row small"><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} />My records only</label>
        <button className="btn" style={{ marginLeft: "auto" }} onClick={() => download(`/exports/observations.csv?${areaId ? `area_id=${areaId}` : ""}`, "chimpwatch_observations.csv").catch((e) => toast(e.message))}>Export CSV</button>
      </div>
      <section className="panel">
        <ErrorBox error={list.error} />
        {list.loading && !list.data ? <Loading /> : list.data?.items.length ? (
          <>
            <div className="table-wrap"><table className="data">
              <thead><tr><th>Observed</th><th>Species</th><th>Evidence</th><th className="num">Count</th><th>Landscape</th><th>Location</th><th>Source</th><th>Status</th></tr></thead>
              <tbody>{list.data.items.map((o) => (
                <tr key={o.id} className="clickable" onClick={() => setSel(o)} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && setSel(o)}>
                  <td>{fmtDate(o.observed_at)}</td>
                  <td>{o.common_name ?? o.species}<div className="xs muted"><i>{o.species}</i></div></td>
                  <td>{humanize(o.evidence_type)}</td>
                  <td className="num">{o.count}</td>
                  <td>{o.area_name ?? <span className="muted">Outside pilot areas</span>}</td>
                  <td className="small">{o.location ? (o.location.generalised ? `~${o.location.precision_km} km cell` : `${o.location.lat.toFixed(4)}, ${o.location.lon.toFixed(4)}`) : "—"}</td>
                  <td>{humanize(o.source)}</td>
                  <td><StatusChip status={o.validation_status} /></td>
                </tr>
              ))}</tbody>
            </table></div>
            <div className="pager">
              <span>{offset + 1}–{Math.min(offset + PAGE, list.data.total)} of {list.data.total.toLocaleString()}</span>
              <div className="row">
                <button className="btn" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Previous</button>
                <button className="btn" disabled={offset + PAGE >= list.data.total} onClick={() => setOffset(offset + PAGE)}>Next</button>
              </div>
            </div>
          </>
        ) : <Empty title="No records match these filters">{can("field_monitor", "analyst") ? "Use Record to add a field observation." : "Try clearing the filters."}</Empty>}
      </section>
      {sel && <ObsDrawer obs={sel} onClose={() => setSel(null)} onChange={(o) => { setSel(o); list.reload(); }} />}
    </>
  );
}

function AuthImage({ id }: { id: number }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let url: string | null = null;
    fetch(`/api/media/${id}`, { headers: { Authorization: `Bearer ${getToken()}` } })
      .then((r) => r.blob()).then((b) => { url = URL.createObjectURL(b); setSrc(url); }).catch(() => {});
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [id]);
  return src ? <img src={src} alt="Observation photo" style={{ width: "100%", borderRadius: 8 }} /> : <div className="skeleton" style={{ height: 160 }} />;
}

function ObsDrawer({ obs, onClose, onChange }: { obs: Observation; onClose: () => void; onChange: (o: Observation) => void }) {
  const { can } = useAuth();
  const media = useApi<{ id: number; classification: { backend: string; top_label?: string; top_confidence?: number; note?: string } }[]>(`/observations/${obs.id}/media`);
  const [note, setNote] = useState("");
  const [err, setErr] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const validate = async (status: "verified" | "rejected") => {
    setBusy(true); setErr(null);
    try {
      const o = await api<Observation>(`/observations/${obs.id}/validate`, { method: "POST", json: { status, note: note || null } });
      toast(status === "verified" ? "Record verified" : "Record rejected");
      onChange(o);
    } catch (e) { setErr(e as Error); } finally { setBusy(false); }
  };
  return (
    <Drawer onClose={onClose} title={<><StatusChip status={obs.validation_status} /><h2 style={{ marginTop: 6 }}>{obs.common_name ?? obs.species}</h2></>}>
      <dl className="kv">
        <dt>Species</dt><dd><i>{obs.species}</i></dd>
        <dt>Evidence</dt><dd>{humanize(obs.evidence_type)}</dd>
        <dt>Count</dt><dd>{obs.count}{obs.adults != null && ` (${obs.adults} adults, ${obs.juveniles ?? 0} juveniles, ${obs.infants ?? 0} infants)`}</dd>
        <dt>Observed</dt><dd>{fmtDate(obs.observed_at, true)}</dd>
        <dt>Landscape</dt><dd>{obs.area_name ?? "Outside pilot areas"}</dd>
        <dt>Location</dt><dd>{obs.location ? (obs.location.generalised
          ? `Generalised to a ~${obs.location.precision_km} km cell to protect the site`
          : `${obs.location.lat.toFixed(5)}, ${obs.location.lon.toFixed(5)}${obs.gps_accuracy_m ? ` (±${obs.gps_accuracy_m} m)` : ""}`) : "—"}</dd>
        <dt>ID confidence</dt><dd>{obs.id_confidence != null ? `${Math.round(obs.id_confidence * 100)}%` : "—"}</dd>
        <dt>Source</dt><dd>{humanize(obs.source)}</dd>
        {obs.notes && <><dt>Notes</dt><dd>{obs.notes}</dd></>}
        {obs.validation_note && <><dt>Validation note</dt><dd>{obs.validation_note}</dd></>}
      </dl>
      {!!media.data?.length && (
        <div className="stack">
          <h3>Photos</h3>
          {media.data.map((m) => (
            <div key={m.id}>
              <AuthImage id={m.id} />
              <p className="xs muted" style={{ marginTop: 4 }}>{m.classification?.top_label
                ? `Model suggests ${m.classification.top_label} (${Math.round((m.classification.top_confidence ?? 0) * 100)}%), awaiting expert confirmation`
                : m.classification?.note ?? "Awaiting expert identification"}</p>
            </div>
          ))}
        </div>
      )}
      {can("analyst") && obs.validation_status === "pending" && (
        <div className="stack" style={{ gap: 10 }}>
          <h3>Validate</h3>
          <label className="field">Note <span className="hint">Required when rejecting</span><textarea className="input" value={note} onChange={(e) => setNote(e.target.value)} /></label>
          <ErrorBox error={err} />
          <div className="row">
            <button className="btn primary" disabled={busy} onClick={() => validate("verified")}>Verify record</button>
            <button className="btn danger" disabled={busy} onClick={() => validate("rejected")}>Reject record</button>
          </div>
        </div>
      )}
    </Drawer>
  );
}

// ---------------------------------------------------------------- pressure reports
interface PressureRow { id: number; area_id: number | null; area_name: string | null; kind: string; severity: number; observed_at: string; lon: number; lat: number; description: string | null; source: string; validation_status: "pending" | "verified" | "rejected" }

function PressuresTab() {
  const { can } = useAuth();
  const [days, setDays] = useState("365");
  const [kind, setKind] = useState("");
  const [status, setStatus] = useState("");
  const list = useApi<PressureRow[]>(`/pressures?days=${days}${kind ? `&kind=${kind}` : ""}`);
  const rows = (list.data ?? []).filter((p) => !status || p.validation_status === status);
  const kinds = [...new Set((list.data ?? []).map((p) => p.kind))].sort();
  const decide = async (p: PressureRow, s: "verified" | "rejected") => {
    try {
      await api(`/pressures/${p.id}/validate`, { method: "POST", json: { status: s, note: null } });
      toast(s === "verified" ? "Pressure report verified" : "Pressure report rejected");
      list.reload();
    } catch (e) { toast((e as Error).message); }
  };
  return (
    <>
      <div className="filters">
        <select className="input" value={days} onChange={(e) => setDays(e.target.value)} aria-label="Period">
          <option value="90">Last 90 days</option><option value="365">Last 12 months</option><option value="1095">Last 3 years</option>
        </select>
        <select className="input" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Type">
          <option value="">All types</option>{kinds.map((k) => <option key={k} value={k}>{humanize(k)}</option>)}
        </select>
        <select className="input" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          <option value="">Any status</option><option value="pending">Awaiting validation</option><option value="verified">Verified</option><option value="rejected">Rejected</option>
        </select>
      </div>
      <section className="panel">
        <ErrorBox error={list.error} />
        {list.loading && !list.data ? <Loading /> : rows.length ? (
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Reported</th><th>Type</th><th className="num">Severity</th><th>Landscape</th><th>Location</th><th>Description</th><th>Status</th>{can("analyst") && <th></th>}</tr></thead>
            <tbody>{rows.map((p) => (
              <tr key={p.id}>
                <td>{fmtDate(p.observed_at)}</td>
                <td>{humanize(p.kind)}</td>
                <td className="num">{["", "Minor", "Moderate", "Severe"][p.severity]}</td>
                <td>{p.area_name ?? <span className="muted">Outside pilot areas</span>}</td>
                <td className="small">{p.lat.toFixed(4)}, {p.lon.toFixed(4)}</td>
                <td className="small" style={{ maxWidth: 280 }}>{p.description ?? "—"}</td>
                <td><StatusChip status={p.validation_status} /></td>
                {can("analyst") && <td>{p.validation_status === "pending" && (
                  <div className="row" style={{ flexWrap: "nowrap" }}>
                    <button className="btn" onClick={() => decide(p, "verified")}>Verify</button>
                    <button className="btn ghost" onClick={() => decide(p, "rejected")}>Reject</button>
                  </div>)}</td>}
              </tr>
            ))}</tbody>
          </table></div>
        ) : <Empty title="No pressure reports match these filters">Rangers add them from Add record → Human pressure.</Empty>}
      </section>
    </>
  );
}

// ---------------------------------------------------------------- surveys
interface SurveyRow { id: number; area_id: number; method: string; start_date: string; end_date: string; effort_km: number | null; effort_trap_days: number | null; team: string | null; source: string; notes?: string | null }

function SurveysTab() {
  const [areaId, setAreaId] = useState("");
  const [mine, setMine] = useState(false);
  const areas = useApi<Area[]>("/areas");
  const list = useApi<SurveyRow[]>(`/surveys?${areaId ? `area_id=${areaId}&` : ""}${mine ? "mine=true" : ""}`);
  const names = Object.fromEntries((areas.data ?? []).map((a) => [a.id, a.name]));
  const totalKm = (list.data ?? []).reduce((t, s) => t + (s.effort_km ?? 0), 0);
  return (
    <>
      <div className="filters">
        <select className="input" value={areaId} onChange={(e) => setAreaId(e.target.value)} aria-label="Landscape">
          <option value="">All landscapes</option>{areas.data?.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <label className="row small"><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} />My surveys only</label>
        {list.data && <span className="small muted" style={{ marginLeft: "auto" }}>{list.data.length} surveys · {totalKm.toLocaleString("en-GB", { maximumFractionDigits: 1 })} km walked</span>}
      </div>
      <section className="panel">
        <ErrorBox error={list.error} />
        {list.loading && !list.data ? <Loading /> : list.data?.length ? (
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Dates</th><th>Landscape</th><th>Method</th><th className="num">Effort</th><th>Team</th><th>Source</th></tr></thead>
            <tbody>{list.data.map((s) => (
              <tr key={s.id}>
                <td>{fmtDate(s.start_date)}{s.end_date !== s.start_date ? ` – ${fmtDate(s.end_date)}` : ""}</td>
                <td>{names[s.area_id] ?? `#${s.area_id}`}</td>
                <td>{humanize(s.method)}</td>
                <td className="num">{s.effort_km != null ? `${s.effort_km} km` : s.effort_trap_days != null ? `${s.effort_trap_days} trap-days` : "—"}</td>
                <td className="small">{s.team ?? "—"}{s.notes ? <div className="xs muted">{s.notes}</div> : null}</td>
                <td>{humanize(s.source)}</td>
              </tr>
            ))}</tbody>
          </table></div>
        ) : <Empty title="No surveys yet">Rangers start one from Add record → Start a survey.</Empty>}
      </section>
    </>
  );
}
