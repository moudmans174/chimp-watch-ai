import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";

/** Landing point after Google / Apple / GitHub. The server puts the result in the URL fragment,
 *  which browsers never send to servers or log, then we clear it from the address bar. */
export default function AuthCallback() {
  const { acceptToken } = useAuth();
  const nav = useNavigate();
  const [state, setState] = useState<{ kind: "working" | "pending" | "created" | "error"; email?: string }>({ kind: "working" });

  useEffect(() => {
    const h = new URLSearchParams(window.location.hash.slice(1));
    window.history.replaceState(null, "", window.location.pathname);
    const token = h.get("token");
    const status = h.get("status");
    if (token) {
      acceptToken(token).then(() => nav("/", { replace: true })).catch(() => setState({ kind: "error" }));
    } else if (status === "created" || status === "pending") {
      setState({ kind: status, email: h.get("email") ?? undefined });
    } else {
      setState({ kind: "error" });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (state.kind === "working") return <div className="auth-center"><p className="muted">Signing you in…</p></div>;

  return (
    <div className="auth-center">
      <div className="auth-box panel panel-pad">
        <img src="/icon.svg" alt="" width={40} />
        {state.kind === "error" ? (
          <>
            <h2>Sign-in didn't complete</h2>
            <p className="muted">The sign-in link was incomplete or has expired. Start again from the sign-in page.</p>
            <Link className="btn primary big" to="/login">Back to sign in</Link>
          </>
        ) : (
          <>
            <h2>{state.kind === "created" ? "Request received" : "Still awaiting approval"}</h2>
            <p>
              {state.kind === "created" ? "Your account" : "The account"}{state.email ? <> for <b>{state.email}</b></> : null} is waiting for an administrator to approve it and assign your organisation and role.
            </p>
            <p className="muted small">You'll be able to sign in with the same option once it's approved. If it's urgent, contact your organisation's CHIMP-WATCH administrator.</p>
            <Link className="btn big" to="/welcome">Back to the home page</Link>
          </>
        )}
      </div>
    </div>
  );
}
