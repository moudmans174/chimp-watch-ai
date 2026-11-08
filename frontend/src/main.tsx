import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import "@fontsource-variable/archivo/standard.css";
import "./styles.css";
import { AuthProvider, useAuth } from "./lib/auth";
import { startAutoSync } from "./lib/offline";
import Layout from "./components/Layout";
import { AuthPage } from "./pages/Login";
import Landing from "./pages/Landing";
import AuthCallback from "./pages/AuthCallback";
import Profile from "./pages/Profile";
import { ForgotPassword, ResetPassword } from "./pages/PasswordReset";
import Dashboard from "./pages/Dashboard";
import MapPage from "./pages/MapPage";
import Alerts from "./pages/Alerts";
import Observations from "./pages/Observations";
import Capture from "./pages/Capture";
import AreaDetail from "./pages/AreaDetail";
import Tasks from "./pages/Tasks";
import Ecosystem from "./pages/Ecosystem";
import Reports from "./pages/Reports";
import Admin from "./pages/Admin";
import type { ReactNode } from "react";
import type { Role } from "./lib/types";

function Guard({ children, roles }: { children: ReactNode; roles?: Role[] }) {
  const { user, ready, can } = useAuth();
  const loc = useLocation();
  if (!ready && !user) return null;
  if (!user) return loc.pathname === "/" ? <Navigate to="/welcome" replace /> : <Navigate to="/login" state={{ from: loc.pathname }} replace />;
  if (roles && !can(...roles)) return <Navigate to="/" replace />;
  return <>{children}</>;
}

function App() {
  return (
    <Routes>
      <Route path="/welcome" element={<Landing />} />
      <Route path="/login" element={<AuthPage mode="signin" />} />
      <Route path="/signup" element={<AuthPage mode="signup" />} />
      <Route path="/auth/callback" element={<AuthCallback />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route element={<Guard><Layout /></Guard>}>
        <Route index element={<Dashboard />} />
        <Route path="map" element={<MapPage />} />
        <Route path="alerts" element={<Alerts />} />
        <Route path="observations" element={<Observations />} />
        <Route path="capture" element={<Guard roles={["field_monitor", "analyst"]}><Capture /></Guard>} />
        <Route path="areas/:id" element={<AreaDetail />} />
        <Route path="tasks" element={<Tasks />} />
        <Route path="ecosystem" element={<Ecosystem />} />
        <Route path="reports" element={<Reports />} />
        <Route path="profile" element={<Profile />} />
        <Route path="admin" element={<Guard roles={[]}><Admin /></Guard>} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

startAutoSync();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthProvider>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </AuthProvider>
  </StrictMode>,
);
