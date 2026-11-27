import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { api } from "../lib/api";
import { onQueueChange, queued, queuedJobs } from "../lib/offline";
import { ROLE_TEXT } from "../lib/format";
import { Icon, ToastHost } from "./ui";
import ForestScene from "./ForestScene";
import NotificationBell from "./NotificationBell";

export default function Layout() {
  const { user, logout, can } = useAuth();
  const loc = useLocation();
  const [online, setOnline] = useState(navigator.onLine);
  const [openHigh, setOpenHigh] = useState(0);
  const [outbox, setOutbox] = useState(0);
  const [pendingUsers, setPendingUsers] = useState(0);
  const [toReview, setToReview] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    const refresh = () => Promise.all([queued(), queuedJobs()]).then(([a, b]) => setOutbox(a.length + b.length)).catch(() => {});
    refresh();
    const un = onQueueChange(refresh);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); un(); };
  }, []);

  useEffect(() => {
    api<{ total: number }>("/alerts?open_only=true&level=high&limit=1").then((r) => setOpenHigh(r.total)).catch(() => {});
    if (user?.role === "admin") api<unknown[]>("/users?pending=true").then((r) => setPendingUsers(r.length)).catch(() => {});
    if (user?.role === "admin" || user?.role === "analyst") api<{ total: number }>("/camera/captures?status=pending&limit=1").then((r) => setToReview(r.total)).catch(() => {});
  }, [user?.role, loc.pathname]);

  useEffect(() => setMenuOpen(false), [loc.pathname]);

  const badge = (n: number, tone: "high" | "medium" = "high", label = "") =>
    n > 0 ? <span className="count" style={tone === "medium" ? { background: "var(--medium)" } : undefined} aria-label={label}>{n}</span> : null;

  const link = (to: string, icon: string, label: string, extra?: React.ReactNode, secondary = false) => (
    <NavLink to={to} end={to === "/"} className={({ isActive }) => `nav-link ${secondary ? "secondary" : ""} ${isActive ? "active" : ""}`}>
      <Icon name={icon} /><span>{label}</span>{extra}
    </NavLink>
  );

  const groups = (
    <>
      {link("/", "dashboard", "Overview")}
      {link("/map", "map", "Map")}
      {link("/alerts", "alert", "Alerts", badge(openHigh, "high", `${openHigh} open high alerts`))}
      <div className="nav-group">Field work</div>
      {can("field_monitor", "analyst") && link("/capture", "field", "Add record", badge(outbox, "medium", `${outbox} waiting to send`))}
      {link("/tasks", "tasks", "Field tasks")}
      {link("/patrols", "route", "Patrols", null, true)}
      {link("/cameras", "camera", "Camera traps", badge(toReview, "medium", `${toReview} photos to review`), true)}
      {link("/observations", "obs", "All records", null, true)}
      <div className="nav-group">Landscape & people</div>
      {link("/conflict", "conflict", "Wildlife conflict", null, true)}
      {link("/community", "people", "Community", null, true)}
      {link("/ecosystem", "eco", "Ecosystem", null, true)}
      <div className="nav-group">Manage</div>
      {link("/reports", "report", "Reports", null, true)}
      {can() && link("/admin", "admin", "Admin", badge(pendingUsers, "medium", `${pendingUsers} access requests`), true)}
    </>
  );

  return (
    <div className="shell">
      <nav className="rail" aria-label="Main">
        <NavLink to="/" className="brand"><img src="/icon.svg" alt="" /><span><b>CHIMP-WATCH</b><small>Sierra Leone pilot</small></span></NavLink>
        <div className="rail-links">{groups}</div>
        <button className="nav-link more-btn" onClick={() => setMenuOpen(true)} aria-label="All sections"><Icon name="menu" /><span>More</span></button>
        <div className="rail-foot">
          <NavLink to="/profile" className="who" style={{ color: "#fff", textDecoration: "none" }}>{user?.full_name}</NavLink>
          <div>{ROLE_TEXT[user?.role ?? "viewer"]} · {user?.org?.name?.replace(" (demo)", "")}</div>
          <div className={`net ${online ? "" : "off"}`}><i />{online ? "Online" : "Offline — records are saved on this device"}</div>
          <div className="row" style={{ gap: 14 }}><NavLink to="/profile" style={{ color: "var(--rail-ink)", fontSize: "var(--fs-s)" }}>Profile</NavLink><button onClick={logout}>Sign out</button></div>
        </div>
        <div className="rail-forest"><ForestScene variant="rail" /></div>
      </nav>
      <main className="main">
        <div className="topbar">
          <div className="mobile-brand"><img src="/icon.svg" alt="CHIMP-WATCH" /><span className={`net ${online ? "" : "off"}`}><i />{online ? "Online" : "Offline"}</span></div>
          <NotificationBell />
        </div>
        <Outlet />
      </main>
      {menuOpen && (
        <>
          <div className="drawer-back" onClick={() => setMenuOpen(false)} />
          <aside className="mobile-menu" role="dialog" aria-label="All sections">
            <div className="spread" style={{ marginBottom: 8 }}><b>All sections</b><button className="btn ghost" onClick={() => setMenuOpen(false)} aria-label="Close">✕</button></div>
            <div className="mobile-menu-links">{groups}</div>
            <div className="mobile-menu-foot">
              <NavLink to="/profile" className="btn">Profile</NavLink>
              <button className="btn" onClick={logout}>Sign out</button>
            </div>
          </aside>
        </>
      )}
      <ToastHost />
    </div>
  );
}
