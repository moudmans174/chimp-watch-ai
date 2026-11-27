import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useApi } from "../lib/useApi";
import { fmtDate, humanize, num } from "../lib/format";
import type { Meta, User } from "../lib/types";
import BarList from "../components/BarList";
import { Drawer, Empty, ErrorBox, Loading, StatusChip, toast } from "../components/ui";

export interface Conflict {
  id: number; occurred_at: string; lon: number; lat: number; area_id: number | null; area_name: string | null;
  district: string | null; community: string | null; species: string; kind: string; crops: string | null;
  loss_estimate_le: number | null; area_damaged_ha: number | null; people_affected: number | null; description: string | null;
  reporter_name: string | null; reporter_phone: string | null; status: string; response_notes: string | null;
  assigned_to: number | null; source: string; created_at: string;
}
interface Summary {
  total: number; open: number; by_kind: Record<string, number>; by_species: Record<string, number>;
  by_district: Record<string, number>; by_status: Record<string, number>; loss_estimate_le: number; area_damaged_ha: number;
}
const STATUS_NEXT: Record<string, { to: string; label: string }[]> = {
  reported: [{ to: "verified", label: "Mark verified" }, { to: "closed", label: "Close" }],
  verified: [{ to: "responded", label: "Mark responded" }, { to: "closed", label: "Close" }],
  responded: [{ to: "closed", label: "Close" }],
  closed: [{ to: "reported", label: "Reopen" }],
};
const le = (v: number | null | undefined) => (v == null ? "—" : `Le ${num(v)}`);

export default function Conflicts() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState("open");
  const [kind, setKind] = useState("");
  const [species, setSpecies] = useState("");
  const [days, setDays] = useState(365);
  const meta = useApi<Meta>("/meta");
  const q = new URLSearchParams({ days: String(days) });
  if (status && status !== "open") q.set("status", status);
  if (kind) q.set("kind", kind);
  if (species) q.set("species", species);
  const list = useApi<Conflict[]>(`/conflicts?${q}`);
  const summary = useApi<Summary>(`/conflicts/summary?days=${days}`);
  const rows = (list.data ?? []).filter((c) => status !== "open" || c.status !== "closed");
  const selId = Number(params.get("id")) || null;
  const sel = list.data?.find((c) => c.id === selId) ?? null;
  const s = summary.data;
  return (
    <>
      <header className="page-head">
        <div>
          <h1>Wildlife conflict</h1>
          <p>Crop raiding, damage and injuries reported by communities around the forests. Incidents feed the food-security picture for each district and help target mitigation.</p>
        </div>
        {can("field_monitor", "analyst") && <div className="page-actions"><Link className="btn primary" to="/capture?tab=conflict">Report an incident</Link></div>}
      </header>
      <section className="stat-strip" aria-label="Conflict summary">
        <div><b>{num(s?.total)}</b><span>incidents</span></div>
        <div><b>{num(s?.open)}</b><span>still open</span></div>
        <div><b>{num(s?.by_kind?.crop_raiding ?? 0)}</b><span>crop raids</span></div>
        <div><b>{num(s?.area_damaged_ha, 1)}</b><span>hectares damaged</span></div>
        <div><b>{s ? le(s.loss_estimate_le) : "—"}</b><span>estimated losses</span></div>
      </section>
      <div className="filters">
        <select className="input" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          <option value="open">Open incidents</option><option value="">All statuses</option>
          {["reported", "verified", "responded", "closed"].map((x) => <option key={x} value={x}>{humanize(x)}</option>)}
        </select>
        <select className="input" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Type">
          <option value="">All types</option>{(meta.data?.conflict_kinds ?? []).map((k) => <option key={k} value={k}>{humanize(k)}</option>)}
        </select>
        <select className="input" value={species} onChange={(e) => setSpecies(e.target.value)} aria-label="Animal">
          <option value="">All animals</option>{(meta.data?.conflict_species ?? []).map((k) => <option key={k} value={k}>{humanize(k)}</option>)}
        </select>
        <div className="segmented" role="group" aria-label="Period">
          {[90, 365].map((d) => <button key={d} aria-pressed={days === d} onClick={() => setDays(d)}>{d === 365 ? "12 months" : "90 days"}</button>)}
        </div>
      </div>
      <div className="two" style={{ alignItems: "start", gridTemplateColumns: "minmax(0,1.7fr) minmax(0,1fr)" }}>
        <section className="panel">
          <ErrorBox error={list.error} />
          {!list.data ? <Loading /> : rows.length ? (
            <div className="table-wrap"><table className="data">
              <thead><tr><th>Date</th><th>Where</th><th>What happened</th><th className="num">Loss</th><th>Status</th></tr></thead>
              <tbody>{rows.map((c) => (
                <tr key={c.id} className="clickable" tabIndex={0} onClick={() => setParams({ id: String(c.id) })} onKeyDown={(e) => e.key === "Enter" && setParams({ id: String(c.id) })}>
                  <td>{fmtDate(c.occurred_at)}</td>
                  <td>{c.community || "—"}<div className="xs muted">{c.district ?? c.area_name ?? ""}</div></td>
                  <td>{humanize(c.kind)}<div className="xs muted">{humanize(c.species)}{c.crops ? ` · ${c.crops}` : ""}</div></td>
                  <td className="num">{le(c.loss_estimate_le)}</td>
                  <td><StatusChip status={c.status} /></td>
                </tr>
              ))}</tbody>
            </table></div>
          ) : <Empty title="No incidents match">Change the filters, or report an incident from the field.</Empty>}
        </section>
        <div className="stack">
          <section className="panel panel-pad"><h2>Which animals</h2><div style={{ marginTop: 10 }}>{s ? <BarList data={s.by_species} /> : <Loading />}</div></section>
          <section className="panel panel-pad"><h2>By district</h2><div style={{ marginTop: 10 }}>{s ? <BarList data={s.by_district} label={(k) => k} /> : <Loading />}</div></section>
          <p className="xs muted">Chimpanzee crop raiding is a conservation risk as well as a livelihood one: it drives retaliation. Prioritise those incidents for response.</p>
        </div>
      </div>
      {sel && <ConflictDrawer c={sel} onClose={() => setParams({})} onChange={() => { list.reload(); summary.reload(); }} />}
    </>
  );
}

function ConflictDrawer({ c, onClose, onChange }: { c: Conflict; onClose: () => void; onChange: () => void }) {
  const { can } = useAuth();
  const analyst = can("analyst");
  const users = useApi<User[]>(analyst ? "/users" : null);
  const [notes, setNotes] = useState(c.response_notes ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<Error | null>(null);
  const patch = async (body: Record<string, unknown>, msg: string) => {
    setBusy(true); setErr(null);
    try { await api(`/conflicts/${c.id}`, { method: "PATCH", json: body }); toast(msg); onChange(); }
    catch (e) { setErr(e as Error); } finally { setBusy(false); }
  };
  return (
    <Drawer title={<><p className="xs muted">{fmtDate(c.occurred_at, true)}</p><h2>{humanize(c.kind)} by {humanize(c.species).toLowerCase()}</h2></>} onClose={onClose}>
      <dl className="kv">
        <dt>Status</dt><dd><StatusChip status={c.status} /></dd>
        <dt>Community</dt><dd>{c.community ?? "—"}{c.district ? `, ${c.district}` : ""}</dd>
        <dt>Landscape</dt><dd>{c.area_name ?? "Not near a pilot landscape"}</dd>
        <dt>Position</dt><dd>{c.lat.toFixed(4)}, {c.lon.toFixed(4)}</dd>
        {c.crops && <><dt>Crops</dt><dd>{c.crops}</dd></>}
        <dt>Area damaged</dt><dd>{c.area_damaged_ha != null ? `${c.area_damaged_ha} ha` : "—"}</dd>
        <dt>Estimated loss</dt><dd>{le(c.loss_estimate_le)}</dd>
        <dt>People affected</dt><dd>{c.people_affected ?? "—"}</dd>
        {analyst && <><dt>Reported by</dt><dd>{c.reporter_name ?? "—"}{c.reporter_phone ? ` · ${c.reporter_phone}` : ""}</dd></>}
        {c.description && <><dt>Description</dt><dd>{c.description}</dd></>}
        {c.response_notes && !analyst && <><dt>Response</dt><dd>{c.response_notes}</dd></>}
      </dl>
      {analyst && (
        <section className="stack" style={{ gap: 10 }}>
          <h3>Response</h3>
          <label className="field">Assigned to
            <select className="input" value={c.assigned_to ?? ""} disabled={busy} onChange={(e) => e.target.value && patch({ assigned_to: Number(e.target.value) }, "Incident assigned")}>
              <option value="">Not assigned</option>
              {(users.data ?? []).filter((u) => u.is_active).map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
            </select>
          </label>
          <label className="field">What was done <span className="hint">Needed before closing</span>
            <textarea className="input" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Site visit, compensation referral, deterrents installed…" />
          </label>
          <ErrorBox error={err} />
          <div className="row" style={{ gap: 8 }}>
            <button className="btn" disabled={busy || notes === (c.response_notes ?? "")} onClick={() => patch({ response_notes: notes }, "Response saved")}>Save response</button>
            {(STATUS_NEXT[c.status] ?? []).map((n) => (
              <button key={n.to} className={n.to === "closed" ? "btn primary" : "btn"} disabled={busy}
                onClick={() => patch({ status: n.to, ...(notes !== (c.response_notes ?? "") ? { response_notes: notes } : {}) }, `Incident ${n.to === "reported" ? "reopened" : n.to}`)}>{n.label}</button>
            ))}
          </div>
        </section>
      )}
    </Drawer>
  );
}
