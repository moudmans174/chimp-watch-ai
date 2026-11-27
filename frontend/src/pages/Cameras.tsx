import { useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useApi } from "../lib/useApi";
import { fmtDate, num } from "../lib/format";
import { SPECIES } from "../lib/species";
import AuthImage from "../components/AuthImage";
import { Drawer, Empty, ErrorBox, Loading, toast } from "../components/ui";

interface Station {
  id: number; code: string; area_id: number | null; area_name: string | null; habitat: string | null; notes: string | null; active: boolean;
  location: { lon: number; lat: number; generalised: boolean; precision_km: number | null } | null;
  active_deployment: { id: number; deployed_on: string; camera_model: string | null; card_id: string | null; trap_days: number } | null;
  deployments: number; trap_days: number; captures: { pending: number; confirmed: number; empty: number; rejected: number };
}
interface Capture {
  id: number; captured_at: string; station_id: number; station_code: string; area_name: string | null; deployment_id: number;
  review_status: string; species: string | null; common_name: string | null; count: number | null;
  classification: { top_label?: string; top_confidence?: number; note?: string } | null;
}
interface Summary { stations: number; active_cameras: number; trap_days_12m: number; captures: Record<string, number>; top_species: { common_name: string | null; species: string; count: number }[] }
type Tab = "stations" | "review" | "confirmed";

export default function Cameras() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as Tab) || "stations";
  const summary = useApi<Summary>("/camera/summary");
  const s = summary.data;
  return (
    <>
      <header className="page-head">
        <div>
          <h1>Camera traps</h1>
          <p>Stations, deployments and photo review. Confirmed photos become verified wildlife records, and every retrieved camera adds trap-days of survey effort.</p>
        </div>
      </header>
      <section className="stat-strip" aria-label="Camera-trap summary">
        <div><b>{num(s?.stations)}</b><span>stations</span></div>
        <div><b>{num(s?.active_cameras)}</b><span>cameras in the field</span></div>
        <div><b>{num(s?.trap_days_12m)}</b><span>trap-days, 12 months</span></div>
        <div><b>{num(s?.captures.pending ?? 0)}</b><span>photos to review</span></div>
        <div><b>{num(s?.captures.confirmed ?? 0)}</b><span>confirmed captures</span></div>
      </section>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === "stations"} onClick={() => setParams({ tab: "stations" })}>Stations</button>
        <button role="tab" aria-selected={tab === "review"} onClick={() => setParams({ tab: "review" })}>Review queue{s?.captures.pending ? ` (${s.captures.pending})` : ""}</button>
        <button role="tab" aria-selected={tab === "confirmed"} onClick={() => setParams({ tab: "confirmed" })}>Confirmed captures</button>
      </div>
      {tab === "stations" && <Stations onChange={summary.reload} />}
      {tab === "review" && <Review status="pending" onChange={summary.reload} />}
      {tab === "confirmed" && <Review status="confirmed" onChange={summary.reload} />}
    </>
  );
}

// ------------------------------------------------------------------ stations
function Stations({ onChange }: { onChange: () => void }) {
  const { can } = useAuth();
  const list = useApi<Station[]>("/camera/stations");
  const [sel, setSel] = useState<Station | null>(null);
  const [adding, setAdding] = useState(false);
  const reload = () => { list.reload(); onChange(); };
  return (
    <>
      <div className="filters">
        {can("field_monitor", "analyst") && <button className="btn primary" onClick={() => setAdding(true)}>Add a station</button>}
        <span className="small muted" style={{ marginLeft: "auto" }}>Station positions are sensitive and generalised unless you have location access.</span>
      </div>
      <section className="panel">
        <ErrorBox error={list.error} />
        {!list.data ? <Loading /> : list.data.length ? (
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Station</th><th>Landscape</th><th>Camera</th><th className="num">Trap-days</th><th className="num">To review</th><th className="num">Confirmed</th><th></th></tr></thead>
            <tbody>{list.data.map((s) => (
              <tr key={s.id} className="clickable" onClick={() => setSel(s)} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && setSel(s)}>
                <td><b>{s.code}</b><div className="xs muted">{s.habitat ?? "—"}</div></td>
                <td>{s.area_name ?? <span className="muted">Outside pilot areas</span>}</td>
                <td>{s.active_deployment
                  ? <span className="chip verified">In the field since {fmtDate(s.active_deployment.deployed_on)}</span>
                  : <span className="chip">{s.active ? "No camera" : "Inactive"}</span>}</td>
                <td className="num">{num(s.trap_days)}</td>
                <td className="num">{s.captures.pending ? <b>{s.captures.pending}</b> : 0}</td>
                <td className="num">{s.captures.confirmed}</td>
                <td><span className="small muted">Manage</span></td>
              </tr>
            ))}</tbody>
          </table></div>
        ) : <Empty title="No camera stations yet">Add a station where you'll set a camera, then deploy a camera on it.</Empty>}
      </section>
      {adding && <AddStation onClose={() => setAdding(false)} onDone={() => { setAdding(false); reload(); }} />}
      {sel && <StationDrawer station={sel} onClose={() => setSel(null)} onChange={async () => { await list.reload(); onChange(); setSel(null); }} />}
    </>
  );
}

function AddStation({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ code: "", lat: "", lon: "", habitat: "", notes: "" });
  const [err, setErr] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const gps = () => navigator.geolocation?.getCurrentPosition(
    (p) => setF((x) => ({ ...x, lat: p.coords.latitude.toFixed(6), lon: p.coords.longitude.toFixed(6) })),
    () => setErr(new Error("Couldn't get your position. Enter coordinates by hand.")), { enableHighAccuracy: true, timeout: 15000 });
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr(null); setBusy(true);
    try {
      await api("/camera/stations", { method: "POST", json: { code: f.code, lat: Number(f.lat), lon: Number(f.lon), habitat: f.habitat || null, notes: f.notes || null } });
      toast("Station added"); onDone();
    } catch (ex) { setErr(ex as Error); } finally { setBusy(false); }
  };
  return (
    <Drawer title={<h2>Add a camera station</h2>} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <label className="field">Station code <span className="hint">Unique, e.g. KH-CT03</span><input className="input" required value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} /></label>
        <div className="row" style={{ alignItems: "end" }}>
          <label className="field" style={{ flex: 1 }}>Latitude<input className="input" inputMode="decimal" required value={f.lat} onChange={(e) => setF({ ...f, lat: e.target.value })} /></label>
          <label className="field" style={{ flex: 1 }}>Longitude<input className="input" inputMode="decimal" required value={f.lon} onChange={(e) => setF({ ...f, lon: e.target.value })} /></label>
          <button type="button" className="btn" onClick={gps}>Use my position</button>
        </div>
        <label className="field">Habitat <span className="hint">Optional</span><input className="input" value={f.habitat} onChange={(e) => setF({ ...f, habitat: e.target.value })} placeholder="Riverine forest, ridge, forest edge…" /></label>
        <label className="field">Notes <span className="hint">Optional</span><textarea className="input" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} placeholder="Access route, mounting tree, landmarks" /></label>
        <ErrorBox error={err} />
        <button className="btn primary" disabled={busy || !f.code || !f.lat || !f.lon}>{busy ? "Saving…" : "Add station"}</button>
      </form>
    </Drawer>
  );
}

function StationDrawer({ station: s, onClose, onChange }: { station: Station; onClose: () => void; onChange: () => void }) {
  const { can } = useAuth();
  const today = new Date().toISOString().slice(0, 10);
  const [dep, setDep] = useState({ deployed_on: today, camera_model: "", card_id: "" });
  const [ret, setRet] = useState({ retrieved_on: today, status: "retrieved" as "retrieved" | "failed", notes: "" });
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<Error | null>(null);
  const run = async (fn: () => Promise<unknown>, msg: string) => {
    setBusy(true); setErr(null);
    try { await fn(); toast(msg); onChange(); } catch (ex) { setErr(ex as Error); } finally { setBusy(false); }
  };
  const a = s.active_deployment;
  const upload = async () => {
    if (!a || !files.length) return;
    let created = 0, dup = 0;
    const errors: string[] = [];
    for (let i = 0; i < files.length; i += 20) {  // batches keep each request small
      const fd = new FormData();
      files.slice(i, i + 20).forEach((f) => fd.append("files", f, f.name));
      const r = await api<{ created: number; duplicates: number; errors: string[] }>(`/camera/deployments/${a.id}/captures`, { method: "POST", body: fd });
      created += r.created; dup += r.duplicates; errors.push(...r.errors);
    }
    if (errors.length) throw new Error(`${created} uploaded, ${dup} duplicates skipped. Problems: ${errors.slice(0, 3).join("; ")}`);
    toast(`${created} photo${created === 1 ? "" : "s"} uploaded${dup ? `, ${dup} duplicates skipped` : ""}`);
  };
  return (
    <Drawer title={<><p className="xs muted">{s.area_name ?? "Outside pilot areas"}</p><h2>Station {s.code}</h2></>} onClose={onClose}>
      <dl className="kv">
        <dt>Location</dt><dd>{s.location ? (s.location.generalised ? `Generalised to a ~${s.location.precision_km} km cell` : `${s.location.lat.toFixed(5)}, ${s.location.lon.toFixed(5)}`) : "—"}</dd>
        <dt>Habitat</dt><dd>{s.habitat ?? "—"}</dd>
        <dt>Deployments</dt><dd>{s.deployments} · {num(s.trap_days)} trap-days in total</dd>
        <dt>Photos</dt><dd>{s.captures.pending} to review · {s.captures.confirmed} confirmed · {s.captures.empty} empty</dd>
        {s.notes && <><dt>Notes</dt><dd>{s.notes}</dd></>}
      </dl>
      <ErrorBox error={err} />
      {can("field_monitor", "analyst") && (a ? (
        <>
          <section className="stack" style={{ gap: 10 }}>
            <h3>Camera in the field</h3>
            <p className="small">Deployed {fmtDate(a.deployed_on)} ({a.trap_days} days){a.camera_model ? ` · ${a.camera_model}` : ""}{a.card_id ? ` · card ${a.card_id}` : ""}</p>
            <label className="field">Upload photos from the card <span className="hint">JPEG, PNG or WebP. Location data is stripped; the photo's own date is kept.</span>
              <input className="input" type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={(e) => setFiles(Array.from(e.target.files || []))} /></label>
            <button className="btn primary" disabled={busy || !files.length} onClick={() => run(upload, "Upload complete")}>{busy ? "Uploading…" : `Upload ${files.length || ""} photo${files.length === 1 ? "" : "s"}`}</button>
          </section>
          <section className="stack" style={{ gap: 10 }}>
            <h3>Retrieve the camera</h3>
            <div className="row" style={{ alignItems: "end" }}>
              <label className="field">Retrieved on<input className="input" type="date" max={today} value={ret.retrieved_on} onChange={(e) => setRet({ ...ret, retrieved_on: e.target.value })} /></label>
              <label className="field">Outcome<select className="input" value={ret.status} onChange={(e) => setRet({ ...ret, status: e.target.value as "retrieved" | "failed" })}>
                <option value="retrieved">Worked normally</option><option value="failed">Failed (no usable effort)</option></select></label>
            </div>
            <label className="field">Notes <span className="hint">Optional</span><input className="input" value={ret.notes} onChange={(e) => setRet({ ...ret, notes: e.target.value })} placeholder="Battery level, damage, theft" /></label>
            <button className="btn" disabled={busy} onClick={() => run(() => api(`/camera/deployments/${a.id}/retrieve`, { method: "POST", json: ret }), "Camera retrieved and trap-days recorded")}>Record retrieval</button>
          </section>
        </>
      ) : (
        <section className="stack" style={{ gap: 10 }}>
          <h3>Deploy a camera</h3>
          <div className="row" style={{ alignItems: "end" }}>
            <label className="field">Deployed on<input className="input" type="date" max={today} value={dep.deployed_on} onChange={(e) => setDep({ ...dep, deployed_on: e.target.value })} /></label>
            <label className="field" style={{ flex: 1 }}>Camera model<input className="input" value={dep.camera_model} onChange={(e) => setDep({ ...dep, camera_model: e.target.value })} placeholder="e.g. Browning BTC-8E" /></label>
          </div>
          <label className="field">SD card ID <span className="hint">Optional</span><input className="input" value={dep.card_id} onChange={(e) => setDep({ ...dep, card_id: e.target.value })} /></label>
          <button className="btn primary" disabled={busy} onClick={() => run(() => api(`/camera/stations/${s.id}/deploy`, { method: "POST", json: { ...dep, camera_model: dep.camera_model || null, card_id: dep.card_id || null } }), "Camera deployed")}>Deploy camera</button>
        </section>
      ))}
    </Drawer>
  );
}

// ------------------------------------------------------------------ review queue / confirmed
function Review({ status, onChange }: { status: "pending" | "confirmed"; onChange: () => void }) {
  const { can } = useAuth();
  const list = useApi<{ total: number; items: Capture[] }>(`/camera/captures?status=${status}&limit=60`);
  const items = list.data?.items ?? [];
  return (
    <>
      <ErrorBox error={list.error} />
      {!list.data ? <Loading /> : items.length ? (
        <div className="capture-grid">
          {items.map((c) => <CaptureCard key={c.id} c={c} canReview={can("analyst")} onDone={() => { list.reload(); onChange(); }} />)}
        </div>
      ) : (
        <section className="panel">{status === "pending"
          ? <Empty title="Nothing to review">New photos appear here when a ranger uploads a camera's card.</Empty>
          : <Empty title="No confirmed captures yet">Confirm photos in the review queue to build the species record.</Empty>}</section>
      )}
      {list.data && list.data.total > items.length && <p className="small muted" style={{ marginTop: 10 }}>Showing the newest {items.length} of {list.data.total}.</p>}
    </>
  );
}

function CaptureCard({ c, canReview, onDone }: { c: Capture; canReview: boolean; onDone: () => void }) {
  const suggestion = c.classification?.top_label;
  const [species, setSpecies] = useState(c.species ?? "");
  const [count, setCount] = useState(c.count ?? 1);
  const [busy, setBusy] = useState(false);
  const decide = async (status: "confirmed" | "empty" | "rejected") => {
    const sp = SPECIES.find((x) => x.sci === species);
    if (status === "confirmed" && !species) { toast("Choose the species first"); return; }
    setBusy(true);
    try {
      await api(`/camera/captures/${c.id}/review`, { method: "POST", json: { status, species: species || null, common_name: sp?.common ?? null, count: status === "confirmed" ? count : null } });
      toast(status === "confirmed" ? `Confirmed: ${sp?.common ?? species}` : status === "empty" ? "Marked empty" : "Marked not usable");
      onDone();
    } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <article className="capture-card">
      <AuthImage path={`/camera/captures/${c.id}/image`} alt={`Camera-trap photo from ${c.station_code}`} className="capture-img" />
      <div className="capture-meta">
        <div className="spread"><b>{c.station_code}</b><span className="xs muted">{new Date(c.captured_at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</span></div>
        <div className="xs muted">{c.area_name ?? "Outside pilot areas"}</div>
        {c.review_status === "confirmed" ? (
          <p className="small" style={{ marginTop: 6 }}><b>{c.common_name ?? c.species}</b>{c.count && c.count > 1 ? ` × ${c.count}` : ""}</p>
        ) : canReview ? (
          <div className="stack" style={{ gap: 8, marginTop: 8 }}>
            {suggestion && <p className="xs">Model suggests <b>{suggestion}</b> ({Math.round((c.classification?.top_confidence ?? 0) * 100)}%)</p>}
            <div className="row" style={{ flexWrap: "nowrap", gap: 6 }}>
              <select className="input" value={species} onChange={(e) => setSpecies(e.target.value)} aria-label="Species" style={{ minHeight: 36, padding: "4px 8px" }}>
                <option value="">Species…</option>{SPECIES.map((s) => <option key={s.sci} value={s.sci}>{s.common}</option>)}
              </select>
              <input className="input" type="number" min={1} max={200} value={count} onChange={(e) => setCount(Number(e.target.value))} aria-label="How many" style={{ width: 64, minHeight: 36, padding: "4px 8px" }} />
            </div>
            <div className="row" style={{ gap: 6 }}>
              <button className="btn primary" disabled={busy} onClick={() => decide("confirmed")}>Confirm</button>
              <button className="btn" disabled={busy} onClick={() => decide("empty")}>Empty</button>
              <button className="btn ghost" disabled={busy} onClick={() => decide("rejected")}>Not usable</button>
            </div>
          </div>
        ) : <p className="xs muted" style={{ marginTop: 6 }}>Awaiting review by an analyst</p>}
      </div>
    </article>
  );
}
