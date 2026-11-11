import type pg from 'pg';
import { type ClientContext, EmailExistsError, type IdentityProvider, type Session, type SignInResult } from './identity.js';

interface GoTrueSession {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  user: { id: string };
}

interface GoTrueError {
  error_code?: string;
  code?: number | string;
  msg?: string;
  message?: string;
  error_description?: string;
}

/**
 * Production identity provider: Supabase Auth (GoTrue) over its REST API.
 *  - admin calls use the service-role key (server-side only)
 *  - password sign-in and refresh use the public anon key, exactly as a browser client would
 * Accounts are created UNCONFIRMED; they cannot sign in until our OTP flow confirms the email.
 *
 * NOTE: this class is verified against a stand-in HTTP server that mimics the documented GoTrue contract
 * (api/test/supabase-identity.test.ts). It has not been run against a live Supabase project.
 */
export class SupabaseIdentity implements IdentityProvider {
  readonly name = 'supabase' as const;
  private readonly base: string;

  constructor(
    baseUrl: string,
    private readonly serviceKey: string,
    private readonly anonKey: string,
    private readonly pool: pg.Pool,
    private readonly timeoutMs = 10_000,
  ) {
    this.base = baseUrl.replace(/\/$/, '') + '/auth/v1';
  }

  private async call(method: string, path: string, opts: { admin?: boolean; body?: unknown; bearer?: string } = {}): Promise<{ status: number; json: any }> {
    const key = opts.admin ? this.serviceKey : this.anonKey;
    const res = await fetch(this.base + path, {
      method,
      headers: { apikey: key, authorization: `Bearer ${opts.bearer ?? key}`, 'content-type': 'application/json' },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, json };
  }

  private static code(json: GoTrueError | null): string {
    return String(json?.error_code ?? json?.code ?? '');
  }

  private static toSession(s: GoTrueSession): Session {
    return { accessToken: s.access_token, refreshToken: s.refresh_token, expiresIn: s.expires_in, userId: s.user.id };
  }

  async createUser(input: { email: string; password: string; fullName: string; phone?: string }): Promise<{ id: string }> {
    const r = await this.call('POST', '/admin/users', {
      admin: true,
      body: { email: input.email, password: input.password, email_confirm: false, user_metadata: { full_name: input.fullName, phone: input.phone ?? '' } },
    });
    if (r.status === 200 || r.status === 201) return { id: r.json.id };
    const code = SupabaseIdentity.code(r.json);
    if (r.status === 422 && (code === 'email_exists' || code === 'user_already_exists')) throw new EmailExistsError();
    throw new Error(`supabase createUser failed (HTTP ${r.status}${code ? `, ${code}` : ''})`);
  }

  async updatePendingUser(id: string, input: { password: string; fullName: string; phone?: string }): Promise<void> {
    const r = await this.call('PUT', `/admin/users/${encodeURIComponent(id)}`, {
      admin: true,
      body: { password: input.password, user_metadata: { full_name: input.fullName, phone: input.phone ?? '' } },
    });
    if (r.status !== 200) throw new Error(`supabase updateUser failed (HTTP ${r.status})`);
  }

  async markEmailVerified(id: string): Promise<void> {
    const r = await this.call('PUT', `/admin/users/${encodeURIComponent(id)}`, { admin: true, body: { email_confirm: true } });
    if (r.status !== 200) throw new Error(`supabase confirm email failed (HTTP ${r.status})`);
  }

  async signIn(email: string, password: string, _ctx: ClientContext): Promise<SignInResult> {
    const r = await this.call('POST', '/token?grant_type=password', { body: { email, password } });
    if (r.status === 200) return { kind: 'ok', session: SupabaseIdentity.toSession(r.json) };
    const code = SupabaseIdentity.code(r.json);
    if (code === 'email_not_confirmed') return { kind: 'unverified' };
    if (r.status === 400 || r.status === 401 || code === 'invalid_credentials') return { kind: 'bad_credentials' };
    throw new Error(`supabase sign-in failed (HTTP ${r.status}${code ? `, ${code}` : ''})`);
  }

  async refresh(refreshToken: string, _ctx: ClientContext): Promise<Session | null> {
    const r = await this.call('POST', '/token?grant_type=refresh_token', { body: { refresh_token: refreshToken } });
    if (r.status === 200) return SupabaseIdentity.toSession(r.json);
    if (r.status === 400 || r.status === 401) return null;
    throw new Error(`supabase refresh failed (HTTP ${r.status})`);
  }

  async revoke(refreshToken: string): Promise<void> {
    // GoTrue ends a session through its own access token: exchange, then log that session out.
    const fresh = await this.refresh(refreshToken, { ip: null, userAgent: null });
    if (!fresh) return;
    await this.call('POST', '/logout?scope=local', { bearer: fresh.accessToken });
  }

  async revokeAllSessions(userId: string): Promise<void> {
    // Deleting the session rows (refresh tokens cascade) prevents any further token refresh.
    // Access tokens already issued stay valid until they expire (Supabase default: 1 hour).
    await this.pool.query('delete from auth.sessions where user_id = $1', [userId]);
  }

  async setPassword(userId: string, newPassword: string): Promise<void> {
    const r = await this.call('PUT', `/admin/users/${encodeURIComponent(userId)}`, { admin: true, body: { password: newPassword } });
    if (r.status !== 200) throw new Error(`supabase set password failed (HTTP ${r.status})`);
  }
}
