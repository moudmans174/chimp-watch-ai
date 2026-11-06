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
  const [tab, setTab] = useState<"users" | "thresholds" | "audit">("users");
  return (
    <>
      <header className="page-head"><div><h1>Administration</h1><p>Accounts, sensitive-location access, alert thresholds and the audit trail.</p></div></header>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === "users"} onClick={() => setTab("users")}>Users</button>
        <button role="tab" aria-selected={tab === "thresholds"} onClick={() => setTab("thresholds")}>Alert thresholds</button>
        <button role="tab" aria-selected={tab === "audit"} onClick={() => setTab("audit")}>Audit log</button>
      </div>
      {tab === "users" && <Users />}
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
