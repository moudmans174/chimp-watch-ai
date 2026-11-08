import { useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import { ErrorBox, toast } from "../components/ui";

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="auth-center">
      <div className="auth-box panel panel-pad">
        <Link to="/welcome" className="row" style={{ textDecoration: "none", color: "inherit" }}><img src="/icon.svg" alt="" width={34} /><b style={{ fontStretch: "125%" }}>CHIMP-WATCH AI</b></Link>
        {children}
      </div>
    </div>
  );
}

export function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr(null); setBusy(true);
    try { await api("/auth/forgot-password", { method: "POST", json: { email } }); setSent(true); }
    catch (ex) { setErr(ex as Error); } finally { setBusy(false); }
  };
  return (
    <Shell>
      {sent ? (
        <>
          <h2>Check your email</h2>
          <p>If an active account uses <b>{email}</b>, we've sent a link to reset the password. The link works once and expires in one hour.</p>
          <p className="small muted">No email after a few minutes? Check your spam folder, or ask your administrator to reset it for you.</p>
          <Link className="btn big" to="/login">Back to sign in</Link>
        </>
      ) : (
        <form className="stack" style={{ gap: 14, width: "100%" }} onSubmit={submit}>
          <h2>Forgot your password?</h2>
          <p className="small muted">Enter your account email and we'll send you a link to choose a new one.</p>
          <label className="field">Email<input className="input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
          <ErrorBox error={err} />
          <button className="btn primary big" disabled={busy || !email}>{busy ? "Sending…" : "Send reset link"}</button>
          <Link className="small" to="/login">Back to sign in</Link>
        </form>
      )}
    </Shell>
  );
}

export function ResetPassword() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const token = params.get("token") ?? "";
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [err, setErr] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr(null);
    if (pw !== confirm) { setErr(new Error("The passwords don't match.")); return; }
    setBusy(true);
    try {
      await api("/auth/reset-password", { method: "POST", json: { token, new_password: pw } });
      toast("Password changed. Sign in with your new password.");
      nav("/login", { replace: true });
    } catch (ex) { setErr(ex as Error); } finally { setBusy(false); }
  };
  if (!token) return <Shell><h2>Reset link incomplete</h2><p className="muted">Open the link from your email again, or request a new one.</p><Link className="btn big" to="/forgot-password">Request a new link</Link></Shell>;
  return (
    <Shell>
      <form className="stack" style={{ gap: 14, width: "100%" }} onSubmit={submit}>
        <h2>Choose a new password</h2>
        <label className="field">New password<input className="input" type="password" autoComplete="new-password" required value={pw} onChange={(e) => setPw(e.target.value)} /></label>
        <label className="field">Repeat new password<input className="input" type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} /></label>
        <p className="xs muted">At least 10 characters, mixing letters with numbers or symbols.</p>
        <ErrorBox error={err} />
        <button className="btn primary big" disabled={busy || !pw}>{busy ? "Saving…" : "Save new password"}</button>
        {err && <Link className="small" to="/forgot-password">Request a new link</Link>}
      </form>
    </Shell>
  );
}
