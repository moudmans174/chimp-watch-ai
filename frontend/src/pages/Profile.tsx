import { useState, type FormEvent } from "react";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useApi } from "../lib/useApi";
import { fmtDate, ROLE_TEXT } from "../lib/format";
import type { User } from "../lib/types";
import { ErrorBox, Loading, toast } from "../components/ui";

export default function Profile() {
  const { acceptToken } = useAuth();
  const me = useApi<User & { phone?: string | null }>("/auth/me");
  const [name, setName] = useState<string | null>(null);
  const [phone, setPhone] = useState<string | null>(null);
  const [err, setErr] = useState<Error | null>(null);
  const [pw, setPw] = useState({ current: "", next: "", confirm: "" });
  const [pwErr, setPwErr] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);

  if (!me.data) return <Loading rows={4} />;
  const u = me.data;

  const save = async (e: FormEvent) => {
    e.preventDefault(); setErr(null); setBusy(true);
    try {
      await api("/auth/me", { method: "PATCH", json: { full_name: name ?? u.full_name, phone: phone ?? u.phone ?? "" } });
      toast("Profile saved");
      const t = localStorage.getItem("cw.token");
      if (t) await acceptToken(t);
      me.reload();
    } catch (ex) { setErr(ex as Error); } finally { setBusy(false); }
  };
  const changePw = async (e: FormEvent) => {
    e.preventDefault(); setPwErr(null);
    if (pw.next !== pw.confirm) { setPwErr(new Error("The new passwords don't match.")); return; }
    setBusy(true);
    try {
      await api("/auth/change-password", { method: "POST", json: { current_password: pw.current, new_password: pw.next } });
      toast("Password changed");
      setPw({ current: "", next: "", confirm: "" });
    } catch (ex) { setPwErr(ex as Error); } finally { setBusy(false); }
  };

  return (
    <>
      <header className="page-head"><div><h1>Your profile</h1><p>Your details and sign-in settings.</p></div></header>
      <div className="two">
        <div className="stack">
          <form className="panel panel-pad stack" onSubmit={save}>
            <h2>Details</h2>
            <label className="field">Full name<input className="input" value={name ?? u.full_name} onChange={(e) => setName(e.target.value)} required /></label>
            <label className="field">Email <span className="hint">Contact an administrator to change it</span><input className="input" value={u.email} disabled /></label>
            <label className="field">Phone <span className="hint">Optional</span><input className="input" type="tel" value={phone ?? u.phone ?? ""} onChange={(e) => setPhone(e.target.value)} /></label>
            <ErrorBox error={err} />
            <div><button className="btn primary" disabled={busy}>Save details</button></div>
          </form>
          {(
            <form className="panel panel-pad stack" onSubmit={changePw}>
              <h2>Change password</h2>
              <label className="field">Current password<input className="input" type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} required /></label>
              <div className="grid2" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <label className="field">New password<input className="input" type="password" autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} required /></label>
                <label className="field">Repeat new password<input className="input" type="password" autoComplete="new-password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} required /></label>
              </div>
              <p className="xs muted">At least 10 characters, mixing letters with numbers or symbols. If you only sign in with Google, Apple or GitHub, use "Forgot password" on the sign-in page to set one.</p>
              <ErrorBox error={pwErr} />
              <div><button className="btn" disabled={busy || !pw.current || !pw.next}>Change password</button></div>
            </form>
          )}
        </div>
        <section className="panel panel-pad">
          <h2>Access</h2>
          <dl className="kv" style={{ marginTop: 14 }}>
            <dt>Role</dt><dd>{ROLE_TEXT[u.role]}</dd>
            <dt>Organisation</dt><dd>{u.org?.name ?? "—"}</dd>
            <dt>Precise locations</dt><dd>{u.can_view_sensitive ? "You can see exact chimpanzee locations" : "Chimpanzee locations are generalised for you"}</dd>
            <dt>Sign-in options</dt><dd>{["Email and password", ...(u.providers ?? []).map((p) => p[0].toUpperCase() + p.slice(1))].join(", ")}</dd>
            <dt>Last sign-in</dt><dd>{fmtDate(u.last_login, true)}</dd>
          </dl>
          <p className="xs muted" style={{ marginTop: 14 }}>An administrator manages roles and location access.</p>
        </section>
      </div>
    </>
  );
}
