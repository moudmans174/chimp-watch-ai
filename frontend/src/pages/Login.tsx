import { useEffect, useState, type FormEvent } from "react";
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { api } from "../lib/api";
import { ErrorBox } from "../components/ui";
import ForestScene from "../components/ForestScene";

type Mode = "signin" | "signup";
type Provider = "google" | "apple" | "github";
const PROVIDERS: { id: Provider; label: string }[] = [
  { id: "google", label: "Google" },
  { id: "apple", label: "Apple" },
  { id: "github", label: "GitHub" },
];
const NAME: Record<string, string> = { google: "Google", apple: "Apple", github: "GitHub" };

function errorText(code: string | null, provider: string | null): string | null {
  const p = provider ? NAME[provider] ?? provider : "the provider";
  switch (code) {
    case null: return null;
    case "no_account": return `There's no account linked to that ${p} sign-in yet. Sign up to request access.`;
    case "email_required": return `${p} didn't share a verified email address. Verify your email with ${p}, or use a different option.`;
    case "cancelled": return `Sign-in with ${p} was cancelled. Try again when you're ready.`;
    case "state_mismatch":
    case "session_expired": return "Your sign-in session expired or was opened in a different browser. Start again.";
    case "not_configured": return `${p} sign-in isn't set up on this server yet. Use another option or ask your administrator.`;
    case "disabled": return "This account has been deactivated. Contact your administrator.";
    default: return `Something went wrong while signing in with ${p}. Try again in a moment.`;
  }
}

export function AuthPage({ mode }: { mode: Mode }) {
  const { user, login } = useAuth();
  const nav = useNavigate();
  const loc = useLocation() as { state?: { from?: string } };
  const [params] = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const [enabled, setEnabled] = useState<Record<string, boolean> | null>(null);
  const urlError = errorText(params.get("error"), params.get("provider"));

  useEffect(() => { api<Record<string, boolean>>("/auth/providers").then(setEnabled).catch(() => setEnabled({})); }, []);

  if (user) return <Navigate to="/" replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
      nav(loc.state?.from || "/", { replace: true });
    } catch (err) {
      setError(err as Error);
    } finally {
      setBusy(false);
    }
  };

  const signup = mode === "signup";
  return (
    <div className="login">
      <section className="login-art">
        <Link to="/welcome" className="row" style={{ color: "#fff", textDecoration: "none" }}>
          <img src="/icon.svg" alt="" width={36} /><b style={{ fontStretch: "125%" }}>CHIMP-WATCH AI</b>
        </Link>
        <div>
          <h1>{signup ? "Request access to the platform." : "Know where the forest is changing."}</h1>
          <p>{signup
            ? "Sign up with Google, Apple, GitHub or your email. An administrator will confirm your organisation and role before you can see any monitoring data."
            : "Chimpanzee monitoring, habitat change and ecosystem early warning for Sierra Leone's protected landscapes."}</p>
        </div>
        <p className="xs" style={{ opacity: 0.7 }}>Sensitive locations are protected. All access is logged.</p>
        <ForestScene variant="panel" />
      </section>

      <section className={`login-form ${signup ? "tall" : ""}`}>
        <div className="auth-box">
          <h2>{signup ? "Create your account" : "Sign in"}</h2>
          {urlError && <div className="error-box" role="alert">{urlError}</div>}

          <div className="providers" role="group" aria-label={signup ? "Sign up with" : "Sign in with"}>
            {PROVIDERS.map((p) => {
              const on = enabled?.[p.id];
              const label = `${signup ? "Sign up" : "Continue"} with ${p.label}`;
              return on ? (
                <a key={p.id} className={`btn provider ${p.id}`} href={`/api/auth/oauth/${p.id}/start?mode=${mode}`}>{label}</a>
              ) : (
                <button key={p.id} className={`btn provider ${p.id}`} disabled title={enabled ? `${p.label} sign-in isn't set up on this server yet` : "Checking…"}>{label}</button>
              );
            })}
            {enabled && !Object.values(enabled).some(Boolean) && (
              <p className="xs muted">Social sign-in isn't configured on this server yet. An administrator can add Google, Apple and GitHub credentials in the server settings.</p>
            )}
          </div>

          {signup ? (
            <>
              <div className="or"><span>or create an account with your email</span></div>
              <SignupForm />
              <p className="small">Already have an account? <Link to="/login">Sign in</Link></p>
            </>
          ) : (
            <>
              <div className="or"><span>or use your email</span></div>
              <form onSubmit={submit} noValidate className="stack" style={{ gap: 14 }}>
                <label className="field">Email
                  <input className="input" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
                </label>
                <label className="field">Password
                  <input className="input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
                </label>
                <ErrorBox error={error} />
                <button className="btn primary big" disabled={busy || !email || !password}>{busy ? "Signing in…" : "Sign in"}</button>
              </form>
              <p className="small">New here? <Link to="/signup">Create an account</Link></p>
            </>
          )}
        </div>
      </section>
    </div>
  );
}

const ROLES: { v: string; label: string; hint: string }[] = [
  { v: "field_monitor", label: "Field monitor", hint: "Submit observations and complete field tasks" },
  { v: "analyst", label: "Analyst", hint: "Validate data, review alerts, run assessments" },
  { v: "viewer", label: "Viewer", hint: "Read dashboards and reports" },
];

function SignupForm() {
  const nav = useNavigate();
  const [f, setF] = useState({ full_name: "", email: "", password: "", confirm: "", organisation: "",
    requested_role: "field_monitor", phone: "", reason: "", accept_terms: false });
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  const pwOk = f.password.length >= 10 && /[^A-Za-z]/.test(f.password) && /[A-Za-z]/.test(f.password);
  const mismatch = f.confirm.length > 0 && f.confirm !== f.password;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!pwOk) { setError(new Error("Use at least 10 characters, mixing letters with numbers or symbols.")); return; }
    if (f.password !== f.confirm) { setError(new Error("The two passwords don't match.")); return; }
    if (f.reason.trim().length < 10) { setError(new Error("Tell us briefly why you need access (at least 10 characters).")); return; }
    if (!f.accept_terms) { setError(new Error("Agree to the data-use terms to continue.")); return; }
    setBusy(true); setError(null);
    try {
      const { confirm: _c, ...body } = f;
      void _c;
      await api("/auth/signup", { method: "POST", json: { ...body, phone: body.phone || null } });
      nav(`/auth/callback#status=created&email=${encodeURIComponent(f.email.trim().toLowerCase())}`, { replace: true });
    } catch (err) { setError(err as Error); } finally { setBusy(false); }
  };

  return (
    <form className="stack signup-form" style={{ gap: 14 }} onSubmit={submit} noValidate>
      <label className="field">Full name
        <input className="input" autoComplete="name" required value={f.full_name} onChange={(e) => set({ full_name: e.target.value })} /></label>
      <label className="field">Email
        <input className="input" type="email" autoComplete="email" required value={f.email} onChange={(e) => set({ email: e.target.value })} /></label>
      <div className="grid2">
        <label className="field">Password
          <input className="input" type="password" autoComplete="new-password" required value={f.password} onChange={(e) => set({ password: e.target.value })} /></label>
        <label className="field">Confirm password
          <input className="input" type="password" autoComplete="new-password" required value={f.confirm} aria-invalid={mismatch} onChange={(e) => set({ confirm: e.target.value })} /></label>
      </div>
      <p className={`xs ${f.password && !pwOk ? "" : "muted"}`} style={{ marginTop: -6, color: f.password && !pwOk ? "var(--high)" : undefined }}>
        {mismatch ? "Passwords don't match yet." : "At least 10 characters, mixing letters with numbers or symbols."}</p>
      <label className="field">Organisation <span className="hint">Park authority, NGO, university or community group you work with</span>
        <input className="input" autoComplete="organization" required value={f.organisation} onChange={(e) => set({ organisation: e.target.value })} /></label>
      <fieldset className="role-pick">
        <legend>Access you need</legend>
        {ROLES.map((r) => (
          <label key={r.v} className={f.requested_role === r.v ? "on" : ""}>
            <input type="radio" name="role" value={r.v} checked={f.requested_role === r.v} onChange={() => set({ requested_role: r.v })} />
            <span><b>{r.label}</b><span className="xs muted">{r.hint}</span></span>
          </label>
        ))}
      </fieldset>
      <label className="field">Phone <span className="hint">Optional. Helps the administrator confirm who you are</span>
        <input className="input" type="tel" autoComplete="tel" inputMode="tel" value={f.phone} onChange={(e) => set({ phone: e.target.value })} placeholder="+232 …" /></label>
      <label className="field">Why do you need access?
        <textarea className="input" required value={f.reason} onChange={(e) => set({ reason: e.target.value })}
          placeholder="Your role, the landscape you work in, and what you'll use the platform for" /></label>
      <label className="row small" style={{ alignItems: "flex-start", flexWrap: "nowrap" }}>
        <input type="checkbox" checked={f.accept_terms} onChange={(e) => set({ accept_terms: e.target.checked })} style={{ marginTop: 3 }} />
        <span>I agree to use CHIMP-WATCH data only for conservation purposes and never to share chimpanzee locations outside the platform.</span>
      </label>
      <ErrorBox error={error} />
      <button className="btn primary big" disabled={busy || !f.full_name || !f.email || !f.password || !f.organisation}>{busy ? "Sending request…" : "Request access"}</button>
      <p className="xs muted">An administrator reviews every request. You'll be able to sign in with this email and password once you're approved.</p>
    </form>
  );
}

export default AuthPage;
