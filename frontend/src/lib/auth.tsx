import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, getToken, setToken, setUnauthorizedHandler } from "./api";
import type { Role, User } from "./types";

const USER_KEY = "cw.user";

interface AuthCtx {
  user: User | null;
  ready: boolean;
  login: (email: string, password: string) => Promise<void>;
  acceptToken: (token: string) => Promise<void>;
  logout: () => void;
  can: (...roles: Role[]) => boolean;
}

const Ctx = createContext<AuthCtx | null>(null);

function cachedUser(): User | null {
  try { const s = localStorage.getItem(USER_KEY); return s ? JSON.parse(s) : null; } catch { return null; }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(() => (getToken() ? cachedUser() : null));
  const [ready, setReady] = useState(false);

  const logout = useCallback(() => {
    setToken(null);
    try { localStorage.removeItem(USER_KEY); } catch { /* ignore */ }
    setUser(null);
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(logout);
    if (!getToken()) { setReady(true); return; }
    api<User>("/auth/me")
      .then((u) => { setUser(u); try { localStorage.setItem(USER_KEY, JSON.stringify(u)); } catch { /* ignore */ } })
      .catch((e) => { if (e.status !== 0) logout(); })  // offline: keep cached user for field capture
      .finally(() => setReady(true));
  }, [logout]);

  const login = async (email: string, password: string) => {
    const body = new URLSearchParams({ username: email, password });
    const res = await api<{ access_token: string; user: User }>("/auth/login", {
      method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    setToken(res.access_token);
    try { localStorage.setItem(USER_KEY, JSON.stringify(res.user)); } catch { /* ignore */ }
    setUser(res.user);
  };

  const acceptToken = async (token: string) => {
    setToken(token);
    const u = await api<User>("/auth/me");
    try { localStorage.setItem(USER_KEY, JSON.stringify(u)); } catch { /* ignore */ }
    setUser(u);
  };

  const can = (...roles: Role[]) => !!user && (user.role === "admin" || roles.includes(user.role));

  return <Ctx.Provider value={{ user, ready, login, acceptToken, logout, can }}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const c = useContext(Ctx);
  if (!c) throw new Error("useAuth outside provider");
  return c;
}
