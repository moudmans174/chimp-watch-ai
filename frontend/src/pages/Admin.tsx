import { useState, type FormEvent } from "react";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useApi } from "../lib/useApi";
import { fmtDate, relTime, ROLE_TEXT } from "../lib/format";
import { INDICATOR_SHORT, type Role, type User } from "../lib/types";
import { ErrorBox, Loading, toast } from "../components/ui";

interface Org { id: number; name: string; kind: string }
interface Threshold { indicator: string; medium: number; high: number; enabled: boolean; description: string | null; updated_at: string }
interface Audit { id: number; at: string; user_id: number | null; action: string; entity: string; entity_id: string | null; detail: Record<string, unknown> | null; ip: string | null }

export default function Admin() {
  const [tab, setTab] = useState<"users" | "orgs" | "areas" | "thresholds" | "audit">("users");
  return (
    <>
      <header className="page-head"><div><h1>Administration</h1><p>Accounts, sensitive-location access, alert thresholds and the audit trail.</p></div></header>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === "users"} onClick={() => setTab("users")}>Users</button>
        <button role="tab" aria-selected={tab === "orgs"} onClick={() => setTab("orgs")}>Organisations</button>
        <button role="tab" aria-selected={tab === "areas"} onClick={() => setTab("areas")}>Landscapes</button>
        <button role="tab" aria-selected={tab === "thresholds"} onClick={() => setTab("thresholds")}>Alert thresholds</button>
        <button role="tab" aria-selected={tab === "audit"} onClick={() => setTab("audit")}>Audit log</button>
      </div>
      {tab === "users" && <Users />}
      {tab === "orgs" && <Organisations />}
      {tab === "areas" && <Landscapes />}
      {tab === "thresholds" && <Thresholds />}
      {tab === "audit" && <AuditLog />}
    </>
  );
}

function Users() {
  const { user: me } = useAuth();
  const users = useApi<User[]>("/users");
  const orgs = useApi<Org[]>("/organisations");
  const [form, setForm] = useState({ email: "", full_name: "", password: "", role: "viewer" as Role, org_id: "", can_view_sensitive: false });
  const [err, setErr] = useState<Error | null>(null);

  const create = async (e: FormEvent) => {
    e.preventDefault(); setErr(null);
    try {
      await api("/users", { method: "POST", json: { ...form, org_id: Number(form.org_id) } });
      toast("Account created"); setForm({ ...form, email: "", full_name: "", password: "" }); users.reload();
    } catch (ex) { setErr(ex as Error); }
  };
  const patch = async (u: User, body: Partial<User>) => {
    try { await api(`/users/${u.id}`, { method: "PATCH", json: body }); toast("Account updated"); users.reload(); }
    catch (ex) { toast((ex as Error).message); }
  };

  const pending = (users.data || []).filter((u) => u.pending_approval);
  const active = (users.data || []).filter((u) => !u.pending_approval);
  return (
    <div className="stack">
    {pending.length > 0 && <Approvals pending={pending} orgs={(orgs.data || []).filter((o) => o.kind !== "pending")} onDone={users.reload} />}
    <div className="admin-users">
      <section className="panel">
        {!users.data ? <Loading /> : (
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Name</th><th>Organisation</th><th>Role</th><th>Precise locations</th><th>Last sign-in</th><th></th></tr></thead>
            <tbody>{active.map((u) => (
              <tr key={u.id} style={{ opacity: u.is_active ? 1 : 0.5 }}>
                <td>{u.full_name}<div className="xs muted">{u.email}{u.providers?.length ? ` · ${u.providers.map((p) => p[0].toUpperCase() + p.slice(1)).join(", ")}` : ""}</div></td>
                <td className="small">{u.org?.name}</td>
                <td><select className="input" style={{ minHeight: 34, padding: "4px 8px" }} value={u.role} disabled={u.id === me?.id} onChange={(e) => patch(u, { role: e.target.value as Role })}>
                  {Object.entries(ROLE_TEXT).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></td>
                <td><label className="row small"><input type="checkbox" checked={u.can_view_sensitive} onChange={(e) => patch(u, { can_view_sensitive: e.target.checked })} />{u.can_view_sensitive ? "Granted" : "Generalised"}</label></td>
                <td className="small muted">{relTime(u.last_login)}</td>
                <td>{u.id !== me?.id && <button className="btn ghost" onClick={() => patch(u, { is_active: !u.is_active })}>{u.is_active ? "Deactivate" : "Reactivate"}</button>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </section>
      <form className="panel panel-pad stack" onSubmit={create}>
        <h2>Add an account</h2>
        <label className="field">Full name<input className="input" required value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} /></label>
        <label className="field">Email<input className="input" type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
        <label className="field">Temporary password <span className="hint">At least 10 characters with a number or symbol</span>
          <input className="input" type="password" required value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></label>
        <label className="field">Organisation<select className="input" required value={form.org_id} onChange={(e) => setForm({ ...form, org_id: e.target.value })}>
          <option value="">Choose…</option>{orgs.data?.filter((o) => o.kind !== "pending").map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></label>
        <label className="field">Role<select className="input" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
          {Object.entries(ROLE_TEXT).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
        <label className="row small"><input type="checkbox" checked={form.can_view_sensitive} onChange={(e) => setForm({ ...form, can_view_sensitive: e.target.checked })} />Can see precise chimpanzee locations</label>
        <ErrorBox error={err} />
        <button className="btn primary">Create account</button>
      </form>
    </div>
    </div>
  );
}

function Approvals({ pending, orgs, onDone }: { pending: User[]; orgs: Org[]; onDone: () => void }) {
  const [choice, setChoice] = useState<Record<number, { org_id: string; role: Role }>>({});
  const [busy, setBusy] = useState<number | null>(null);
  const decide = async (u: User, approve: boolean) => {
    const c = choice[u.id] ?? { org_id: "", role: (u.requested_role ?? "viewer") as Role };
    if (approve && !c.org_id) { toast("Choose an organisation before approving."); return; }
    setBusy(u.id);
    try {
      await api(`/users/${u.id}`, { method: "PATCH", json: approve ? { is_active: true, org_id: Number(c.org_id), role: c.role } : { is_active: false } });
      toast(approve ? `Approved ${u.full_name}` : `Declined ${u.full_name}`);
      onDone();
    } catch (e) { toast((e as Error).message); } finally { setBusy(null); }
  };
  return (
    <section className="panel" style={{ borderColor: "var(--medium)" }}>
      <div className="panel-head"><h2>Access requests</h2><span className="sub">{pending.length} waiting · new accounts can't see any data until approved</span></div>
      <div className="table-wrap"><table className="data">
        <thead><tr><th>Person</th><th>Their details</th><th>Requested</th><th>Assign organisation</th><th>Role</th><th></th></tr></thead>
        <tbody>{pending.map((u) => {
          const c = choice[u.id] ?? { org_id: "", role: (u.requested_role ?? "viewer") as Role };
          const set = (p: Partial<typeof c>) => setChoice((x) => ({ ...x, [u.id]: { ...c, ...p } }));
          return (
            <tr key={u.id}>
              <td>{u.full_name}<div className="xs muted">{u.email}</div>
                <div className="xs muted">Signed up with {(u.providers || []).map((p) => p[0].toUpperCase() + p.slice(1)).join(", ") || "email"}{u.phone ? ` · ${u.phone}` : ""}</div></td>
              <td className="small" style={{ maxWidth: 340 }}>
                {u.requested_org ? <div><b>{u.requested_org}</b>{u.requested_role ? ` · wants ${ROLE_TEXT[u.requested_role] ?? u.requested_role}` : ""}</div> : <span className="muted">No details given</span>}
                {u.signup_note && <div className="muted" style={{ marginTop: 2 }}>“{u.signup_note}”</div>}
              </td>
              <td className="small muted">{relTime(u.created_at)}</td>
              <td><select className="input" style={{ minHeight: 34, padding: "4px 8px" }} value={c.org_id} onChange={(e) => set({ org_id: e.target.value })} aria-label="Organisation">
                <option value="">Choose…</option>{orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></td>
              <td><select className="input" style={{ minHeight: 34, padding: "4px 8px" }} value={c.role} onChange={(e) => set({ role: e.target.value as Role })} aria-label="Role">
                {Object.entries(ROLE_TEXT).filter(([v]) => v !== "admin").map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></td>
              <td><div className="row" style={{ flexWrap: "nowrap" }}>
                <button className="btn primary" disabled={busy === u.id} onClick={() => decide(u, true)}>Approve</button>
                <button className="btn danger" disabled={busy === u.id} onClick={() => decide(u, false)}>Decline</button>
              </div></td>
            </tr>
          );
        })}</tbody>
      </table></div>
    </section>
  );
}

function Thresholds() {
  const th = useApi<Threshold[]>("/thresholds");
  const [edit, setEdit] = useState<Record<string, { medium: number; high: number; enabled: boolean }>>({});
  const save = async (t: Threshold) => {
    const v = edit[t.indicator];
    try { await api(`/thresholds/${t.indicator}`, { method: "PUT", json: v }); toast("Threshold saved. It applies from the next assessment."); th.reload(); setEdit((e) => { const n = { ...e }; delete n[t.indicator]; return n; }); }
    catch (ex) { toast((ex as Error).message); }
  };
  if (!th.data) return <Loading />;
  return (
    <section className="panel">
      <div className="note-box" style={{ margin: 16 }}>Set thresholds with conservation specialists and calibrate them to data quality. Scores run 0–100; an indicator with low confidence is never raised above medium.</div>
      <div className="table-wrap"><table className="data">
        <thead><tr><th>Indicator</th><th>Basis</th><th className="num">Medium from</th><th className="num">High from</th><th>Enabled</th><th>Last changed</th><th></th></tr></thead>
        <tbody>{th.data.map((t) => {
          const v = edit[t.indicator] ?? { medium: t.medium, high: t.high, enabled: t.enabled };
          const set = (p: Partial<typeof v>) => setEdit((e) => ({ ...e, [t.indicator]: { ...v, ...p } }));
          return (
            <tr key={t.indicator}>
              <td><b>{INDICATOR_SHORT[t.indicator]}</b><div className="xs muted">{t.description}</div></td>
              <td className="small">{t.indicator === "population_concern" ? "Modelled" : "Observed"}</td>
              <td className="num"><input className="input" style={{ width: 80 }} type="number" min={0} max={100} value={v.medium} onChange={(e) => set({ medium: Number(e.target.value) })} /></td>
              <td className="num"><input className="input" style={{ width: 80 }} type="number" min={0} max={100} value={v.high} onChange={(e) => set({ high: Number(e.target.value) })} /></td>
              <td><input type="checkbox" checked={v.enabled} onChange={(e) => set({ enabled: e.target.checked })} aria-label="Enabled" /></td>
              <td className="small muted">{fmtDate(t.updated_at)}</td>
              <td><button className="btn" disabled={!edit[t.indicator]} onClick={() => save(t)}>Save</button></td>
            </tr>
          );
        })}</tbody>
      </table></div>
    </section>
  );
}

function AuditLog() {
  const log = useApi<Audit[]>("/audit?limit=300");
  const users = useApi<User[]>("/users");
  const names = Object.fromEntries((users.data || []).map((u) => [u.id, u.full_name]));
  if (log.error) return <ErrorBox error={log.error} />;
  if (!log.data) return <Loading />;
  return (
    <section className="panel"><div className="table-wrap"><table className="data">
      <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Record</th><th>Detail</th><th>IP</th></tr></thead>
      <tbody>{log.data.map((a) => (
        <tr key={a.id}><td className="small">{fmtDate(a.at, true)}</td><td>{a.user_id ? names[a.user_id] ?? `#${a.user_id}` : "System"}</td>
          <td>{a.action.replace(/_/g, " ")}</td><td>{a.entity}{a.entity_id ? ` #${a.entity_id}` : ""}</td>
          <td className="xs muted" style={{ maxWidth: 360, wordBreak: "break-word" }}>{a.detail ? JSON.stringify(a.detail) : ""}</td><td className="xs muted">{a.ip}</td></tr>
      ))}</tbody>
    </table></div></section>
  );
}


// ---------------------------------------------------------------- organisations
const ORG_KINDS: [string, string][] = [["government", "Government / protected-area authority"], ["ngo", "NGO"], ["research", "Research institution"], ["community", "Community group"], ["partner", "Partner"]];

function Organisations() {
  const orgs = useApi<(Org & { country: string })[]>("/organisations");
  const users = useApi<User[]>("/users");
  const [name, setName] = useState("");
  const [kind, setKind] = useState("ngo");
  const [err, setErr] = useState<Error | null>(null);
  const counts: Record<number, number> = {};
  (users.data ?? []).forEach((u) => { counts[u.org_id] = (counts[u.org_id] ?? 0) + 1; });
  const create = async (e: FormEvent) => {
    e.preventDefault(); setErr(null);
    try { await api("/organisations", { method: "POST", json: { name, kind, country: "SL" } }); toast("Organisation added"); setName(""); orgs.reload(); }
    catch (ex) { setErr(ex as Error); }
  };
  return (
    <div className="admin-users">
      <section className="panel">
        {!orgs.data ? <Loading /> : (
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Organisation</th><th>Type</th><th className="num">People</th></tr></thead>
            <tbody>{orgs.data.map((o) => (
              <tr key={o.id}><td>{o.name}</td><td className="small">{ORG_KINDS.find(([k]) => k === o.kind)?.[1] ?? o.kind}</td><td className="num">{counts[o.id] ?? 0}</td></tr>
            ))}</tbody>
          </table></div>
        )}
      </section>
      <form className="panel panel-pad stack" onSubmit={create}>
        <h2>Add an organisation</h2>
        <label className="field">Name<input className="input" required value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Tacugama Chimpanzee Sanctuary" /></label>
        <label className="field">Type<select className="input" value={kind} onChange={(e) => setKind(e.target.value)}>{ORG_KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        <ErrorBox error={err} />
        <button className="btn primary" disabled={name.trim().length < 2}>Add organisation</button>
        <p className="xs muted">People are assigned to an organisation when you approve or create their account.</p>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------- landscapes
interface AreaRow { id: number; name: string; designation: string; district: string; area_km2: number | null; boundary_source: string | null; description: string | null }

function Landscapes() {
  const areas = useApi<AreaRow[]>("/areas");
  const [f, setF] = useState({ name: "", designation: "National park", district: "", boundary_source: "", description: "" });
  const [boundary, setBoundary] = useState<object | null>(null);
  const [fileName, setFileName] = useState("");
  const [replaceFor, setReplaceFor] = useState<number | null>(null);
  const [err, setErr] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);

  const readFile = async (file: File | undefined) => {
    setErr(null); setBoundary(null); setFileName("");
    if (!file) return;
    if (file.size > 15 * 1024 * 1024) { setErr(new Error("The file is larger than 15 MB. Simplify the boundary first.")); return; }
    try {
      const json = JSON.parse(await file.text());
      if (!["Feature", "FeatureCollection", "Polygon", "MultiPolygon"].includes(json.type)) throw new Error();
      setBoundary(json); setFileName(file.name);
      if (json.type === "FeatureCollection" && json.features?.[0]?.properties) {
        const pr = json.features[0].properties;
        setF((x) => ({ ...x, name: x.name || pr.NAME || pr.name || "", designation: pr.DESIG_ENG || x.designation, boundary_source: x.boundary_source || (pr.WDPAID ? `WDPA ${pr.WDPAID}` : "") }));
      }
    } catch { setErr(new Error("That isn't a GeoJSON polygon file. Export the boundary as GeoJSON (WGS84) and try again.")); }
  };
  const create = async (e: FormEvent) => {
    e.preventDefault(); setErr(null);
    if (!boundary) { setErr(new Error("Choose a boundary file.")); return; }
    setBusy(true);
    try {
      if (replaceFor) await api(`/areas/${replaceFor}`, { method: "PATCH", json: { boundary, boundary_source: f.boundary_source || undefined } });
      else await api("/areas", { method: "POST", json: { ...f, country: "SL", boundary } });
      toast(replaceFor ? "Boundary replaced" : "Landscape added. Run an assessment to compute its indicators.");
      setF({ name: "", designation: "National park", district: "", boundary_source: "", description: "" });
      setBoundary(null); setFileName(""); setReplaceFor(null); areas.reload();
    } catch (ex) { setErr(ex as Error); } finally { setBusy(false); }
  };
  const target = areas.data?.find((a) => a.id === replaceFor);
  return (
    <div className="admin-users">
      <section className="panel">
        {!areas.data ? <Loading /> : (
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Landscape</th><th>District</th><th className="num">Area</th><th>Boundary source</th><th></th></tr></thead>
            <tbody>{areas.data.map((a) => (
              <tr key={a.id}><td>{a.name}<div className="xs muted">{a.designation}</div></td><td>{a.district}</td>
                <td className="num">{a.area_km2 != null ? `${Math.round(a.area_km2).toLocaleString("en-GB")} km²` : "—"}</td>
                <td className="small" style={{ maxWidth: 260 }}>{a.boundary_source ?? "—"}</td>
                <td><button className="btn ghost" onClick={() => { setReplaceFor(a.id); setErr(null); }}>Replace boundary</button></td></tr>
            ))}</tbody>
          </table></div>
        )}
      </section>
      <form className="panel panel-pad stack" onSubmit={create}>
        <h2>{target ? `Replace boundary: ${target.name}` : "Add a landscape"}</h2>
        <label className="field">Boundary file <span className="hint">GeoJSON in WGS84, e.g. exported from QGIS or downloaded from Protected Planet (WDPA)</span>
          <input className="input" type="file" accept=".geojson,.json,application/geo+json,application/json" onChange={(e) => readFile(e.target.files?.[0])} /></label>
        {fileName && <div className="note-box">Loaded {fileName}</div>}
        {!target && (
          <>
            <label className="field">Name<input className="input" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <label className="field">Designation<select className="input" value={f.designation} onChange={(e) => setF({ ...f, designation: e.target.value })}>
                {["National park", "Forest reserve", "Community forest", "Wildlife sanctuary", "Corridor", "Other"].map((d) => <option key={d}>{d}</option>)}</select></label>
              <label className="field">District<input className="input" required value={f.district} onChange={(e) => setF({ ...f, district: e.target.value })} /></label>
            </div>
            <label className="field">Description <span className="hint">Optional</span><textarea className="input" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></label>
          </>
        )}
        <label className="field">Boundary source<input className="input" value={f.boundary_source} onChange={(e) => setF({ ...f, boundary_source: e.target.value })} placeholder="e.g. WDPA 2026-10 / NPAA official boundary" /></label>
        <ErrorBox error={err} />
        <div className="row">
          <button className="btn primary" disabled={busy || !boundary || (!target && (!f.name || !f.district))}>{busy ? "Saving…" : target ? "Replace boundary" : "Add landscape"}</button>
          {target && <button type="button" className="btn ghost" onClick={() => setReplaceFor(null)}>Cancel</button>}
        </div>
      </form>
    </div>
  );
}
