import { useState, type FormEvent } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { ErrorBox } from "../components/ui";

export default function Login() {
  const { user, login } = useAuth();
  const nav = useNavigate();
  const loc = useLocation() as { state?: { from?: string } };
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);

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

  return (
    <div className="login">
      <section className="login-art">
        <div className="row"><img src="/icon.svg" alt="" width={36} /><b style={{ fontStretch: "125%" }}>CHIMP-WATCH AI</b></div>
        <div>
          <h1>Know where the forest is changing.</h1>
          <p>Chimpanzee monitoring, habitat change and ecosystem early warning for Sierra Leone's protected landscapes — built for rangers, researchers and decision-makers.</p>
        </div>
        <p className="xs" style={{ opacity: 0.7 }}>Access is restricted to authorised partners. Sensitive locations are protected.</p>
        <svg className="contours" viewBox="0 0 400 300" fill="none" stroke="#9CC5A6" strokeWidth="1.2" aria-hidden="true">
          {Array.from({ length: 11 }, (_, i) => (
            <path key={i} d={`M${-20 + i * 6},${300 - i * 4} C ${80 + i * 8},${210 - i * 16} ${150 - i * 4},${150 - i * 9} ${230 + i * 3},${120 - i * 6} S ${360 - i * 6},${60 + i * 5} ${430},${30 + i * 14}`} />
          ))}
        </svg>
      </section>
      <section className="login-form">
        <form onSubmit={submit} noValidate>
          <h2>Sign in</h2>
          <label className="field">Email
            <input className="input" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label className="field">Password
            <input className="input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          <ErrorBox error={error} />
          <button className="btn primary big" disabled={busy || !email || !password}>{busy ? "Signing in…" : "Sign in"}</button>
          <p className="xs muted">Ask your organisation's administrator if you need an account or have forgotten your password.</p>
        </form>
      </section>
    </div>
  );
}
