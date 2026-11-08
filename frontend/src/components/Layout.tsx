import { useEffect, useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { api } from "../lib/api";
import { onQueueChange, queued } from "../lib/offline";
import { ROLE_TEXT } from "../lib/format";
import { Icon, ToastHost } from "./ui";
import ForestScene from "./ForestScene";

export default function Layout() {
  const { user, logout, can } = useAuth();
  const [online, setOnline] = useState(navigator.onLine);
  const [openHigh, setOpenHigh] = useState(0);
  const [outbox, setOutbox] = useState(0);
  const [pendingUsers, setPendingUsers] = useState(0);

  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    const refresh = () => queued().then((q) => setOutbox(q.length)).catch(() => {});
    refresh();
    const un = onQueueChange(refresh);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); un(); };
  }, []);

  useEffect(() => {
    api<{ total: number }>("/alerts?open_only=true&level=high&limit=1").then((r) => setOpenHigh(r.total)).catch(() => {});
    if (user?.role === "admin") api<unknown[]>("/users?pending=true").then((r) => setPendingUsers(r.length)).catch(() => {});
  }, [user?.role]);

  const link = (to: string, icon: string, label: string, extra?: React.ReactNode, secondary = false) => (
    <NavLink to={to} end={to === "/"} className={({ isActive }) => `nav-link ${secondary ? "secondary" : ""} ${isActive ? "active" : ""}`}>
      <Icon name={icon} /><span>{label}</span>{extra}
    </NavLink>
  );

  return (
    <div className="shell">
      <nav className="rail" aria-label="Main">
        <NavLink to="/" className="brand"><img src="/icon.svg" alt="" /><span><b>CHIMP-WATCH</b><small>Sierra Leone pilot</small></span></NavLink>
        {link("/", "dashboard", "Overview")}
        {link("/map", "map", "Map")}
        {link("/alerts", "alert", "Alerts", openHigh > 0 ? <span className="count" aria-label={`${openHigh} open high alerts`}>{openHigh}</span> : null)}
        {can("field_monitor", "analyst") && link("/capture", "field", "Add record", outbox > 0 ? <span className="count" style={{ background: "var(--medium)" }}>{outbox}</span> : null)}
        {link("/observations", "obs", "All records", null, true)}
        {link("/tasks", "tasks", "Field tasks")}
        {link("/ecosystem", "eco", "Ecosystem", null, true)}
        {link("/reports", "report", "Reports", null, true)}
        {can() && link("/admin", "admin", "Admin", pendingUsers > 0 ? <span className="count" style={{ background: "var(--medium)" }} aria-label={`${pendingUsers} access requests`}>{pendingUsers}</span> : null, true)}
        <div className="rail-foot">
          <NavLink to="/profile" className="who" style={{ color: "#fff", textDecoration: "none" }}>{user?.full_name}</NavLink>
          <div>{ROLE_TEXT[user?.role ?? "viewer"]} · {user?.org?.name?.replace(" (demo)", "")}</div>
          <div className={`net ${online ? "" : "off"}`}><i />{online ? "Online" : "Offline — records are saved on this device"}</div>
          <div className="row" style={{ gap: 14 }}><NavLink to="/profile" style={{ color: "var(--rail-ink)", fontSize: "var(--fs-s)" }}>Profile</NavLink><button onClick={logout}>Sign out</button></div>
        </div>
        <div className="rail-forest"><ForestScene variant="rail" /></div>
      </nav>
      <main className="main">
        <div className="mobile-top">
          <img src="/icon.svg" alt="CHIMP-WATCH" />
          <div className="row small">
            <span className={`net ${online ? "" : "off"}`} style={{ marginTop: 0 }}><i />{online ? "Online" : "Offline"}</span>
            <NavLink to="/observations" className="btn ghost">All records</NavLink>
            <NavLink to="/profile" className="btn ghost">Profile</NavLink>
            <button className="btn ghost" onClick={logout}>Sign out</button>
          </div>
        </div>
        <Outlet />
      </main>
      <ToastHost />
    </div>
  );
}
