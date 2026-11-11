/**
 * API client.
 *  - The access token lives only in memory (never localStorage), so XSS cannot steal a long-lived credential.
 *  - The refresh token is an HttpOnly cookie managed by the server; a silent refresh restores the session.
 *  - Every call is same-origin (/api): Vite proxies in development, Vercel rewrites in production.
 */
const BASE = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, '') ?? '';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: any,
    readonly retryAfterSec?: number,
  ) {
    super(message);
  }
  get isNetwork(): boolean {
    return this.status === 0;
  }
}

let accessToken: string | null = null;
let refreshing: Promise<boolean> | null = null;
const listeners = new Set<(signedIn: boolean) => void>();

export const tokenStore = {
  get: () => accessToken,
  set(t: string | null) {
    const was = accessToken !== null;
    accessToken = t;
    if (was !== (t !== null)) listeners.forEach((l) => l(t !== null));
  },
  subscribe(fn: (signedIn: boolean) => void) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

async function raw(path: string, init: RequestInit & { auth?: boolean; json?: unknown } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('x-requested-with', 'nba-web');
  if (init.json !== undefined) {
    headers.set('content-type', 'application/json');
    init.body = JSON.stringify(init.json);
  }
  if (init.auth !== false && accessToken) headers.set('authorization', `Bearer ${accessToken}`);
  try {
    return await fetch(`${BASE}${path}`, { ...init, headers, credentials: 'include' });
  } catch {
    throw new ApiError(0, 'network', 'Could not reach the server. Check your connection.');
  }
}

async function parse<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error page */
  }
  if (!res.ok) {
    const retry = Number(res.headers.get('retry-after')) || undefined;
    const e = body?.error;
    throw new ApiError(res.status, e?.code ?? 'error', e?.message ?? `Request failed (${res.status}).`, e?.details, retry);
  }
  return body as T;
}

/** Exchanges the refresh cookie for a new access token. Concurrent callers share one request. */
export function refreshSession(): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      const res = await raw('/api/auth/refresh', { method: 'POST', auth: false });
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) accessToken && tokenStore.set(null);
        return false;
      }
      const body = (await res.json()) as { accessToken: string };
      tokenStore.set(body.accessToken);
      return true;
    } catch {
      return false; // offline: keep whatever we have, the caller decides
    } finally {
      setTimeout(() => (refreshing = null), 0);
    }
  })();
  return refreshing;
}

export async function api<T = any>(path: string, init: RequestInit & { auth?: boolean; json?: unknown } = {}): Promise<T> {
  let res = await raw(path, init);
  if (res.status === 401 && init.auth !== false && !path.startsWith('/api/auth/')) {
    if (await refreshSession()) res = await raw(path, init);
  }
  return parse<T>(res);
}

export const get = <T = any>(path: string) => api<T>(path);
export const post = <T = any>(path: string, json?: unknown, auth = true) => api<T>(path, { method: 'POST', json: json ?? {}, auth });
export const patch = <T = any>(path: string, json?: unknown) => api<T>(path, { method: 'PATCH', json });
export const put = <T = any>(path: string, json?: unknown) => api<T>(path, { method: 'PUT', json });
export const del = <T = any>(path: string) => api<T>(path, { method: 'DELETE' });
