import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, get, post, refreshSession, tokenStore } from './api';

export interface User {
  id: string;
  email: string;
  fullName: string;
  role: 'user' | 'admin';
}

interface AuthState {
  user: User | null;
  /** True until the first silent-refresh attempt has finished. */
  loading: boolean;
  login(email: string, password: string): Promise<void>;
  logout(): Promise<void>;
  /** Re-reads the profile (after a refresh of the page the token is restored from the cookie). */
  reload(): Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const loadMe = useCallback(async () => {
    const r = await get<{ user: User }>('/api/auth/me');
    setUser({ id: r.user.id, email: r.user.email, fullName: r.user.fullName, role: r.user.role });
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        if (await refreshSession()) await loadMe();
      } catch {
        /* signed out or offline */
      } finally {
        if (alive) setLoading(false);
      }
    })();
    const off = tokenStore.subscribe((signedIn) => {
      if (!signedIn) setUser(null);
    });
    return () => {
      alive = false;
      off();
    };
  }, [loadMe]);

  const login = useCallback(async (email: string, password: string) => {
    const r = await api<{ accessToken: string; user: User }>('/api/auth/login', { method: 'POST', json: { email, password }, auth: false });
    tokenStore.set(r.accessToken);
    setUser(r.user);
  }, []);

  const logout = useCallback(async () => {
    try {
      await post('/api/auth/logout', {}, false);
    } catch {
      /* the cookie is cleared server-side; local state is cleared regardless */
    }
    tokenStore.set(null);
    setUser(null);
    try {
      localStorage.removeItem(ACTIVE_KEY);
    } catch {
      /* storage unavailable */
    }
  }, []);

  const value = useMemo<AuthState>(() => ({ user, loading, login, logout, reload: loadMe }), [user, loading, login, logout, loadMe]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}

export const ACTIVE_KEY = 'nba.activeTest';
