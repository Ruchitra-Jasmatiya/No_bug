/**
 * SupabaseIdentity against a STAND-IN for Supabase Auth (GoTrue) that follows its documented REST contract.
 * This verifies our client code (keys, headers, error mapping, end-to-end flow). It is NOT a test against a live
 * Supabase project; that has to be done once with real credentials.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';
import pg from 'pg';
import { createApp } from '../src/app.js';
import { SupabaseIdentity } from '../src/auth/supabase-identity.js';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/lib/logger.js';
import { DB_URL, FakeQueue, testApiConfig } from './helpers.js';
import { MemoryTransport } from '../src/email/transports.js';

const SERVICE = 'service-role-key-ABC';
const ANON = 'anon-key-XYZ';
const suite = DB_URL ? describe : describe.skip;

suite('SupabaseIdentity vs stand-in GoTrue', () => {
  const pool = new pg.Pool({ connectionString: DB_URL, max: 4 });
  const users = new Map<string, { id: string; email: string; password: string; confirmed: boolean }>();
  const sessions = new Map<string, string>(); // refresh token -> user id
  const seen: Array<{ method: string; url: string; apikey: string | undefined; auth: string | undefined }> = [];
  let server: http.Server;
  let baseUrl: string;
  const created: string[] = [];

  const json = (res: http.ServerResponse, status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));

  before(async () => {
    await pool.query('create table if not exists auth.sessions (id uuid primary key default gen_random_uuid(), user_id uuid)');
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', async () => {
        const url = new URL(req.url ?? '/', 'http://x');
        const body = raw ? JSON.parse(raw) : {};
        seen.push({ method: req.method ?? '', url: url.pathname + url.search, apikey: req.headers.apikey as string, auth: req.headers.authorization });
        const isAdmin = url.pathname.startsWith('/auth/v1/admin/');
        if (isAdmin && req.headers.authorization !== `Bearer ${SERVICE}`) return json(res, 401, { code: 401, msg: 'not admin' });

        if (req.method === 'POST' && url.pathname === '/auth/v1/admin/users') {
          if ([...users.values()].some((u) => u.email === body.email)) return json(res, 422, { code: 422, error_code: 'email_exists', msg: 'A user with this email address has already been registered' });
          const id = randomUUID();
          users.set(id, { id, email: body.email, password: body.password, confirmed: body.email_confirm === true });
          // On a real project the profile trigger fires on insert into auth.users; emulate that here.
          await pool.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1,$2,$3)`, [id, body.email, JSON.stringify(body.user_metadata ?? {})]);
          created.push(body.email);
          return json(res, 200, { id, email: body.email });
        }
        const put = /^\/auth\/v1\/admin\/users\/([^/]+)$/.exec(url.pathname);
        if (req.method === 'PUT' && put) {
          const u = users.get(put[1]!);
          if (!u) return json(res, 404, { code: 404, error_code: 'user_not_found' });
          if (body.password) u.password = body.password;
          if (body.email_confirm === true) {
            u.confirmed = true;
            await pool.query('update auth.users set email_confirmed_at = now() where id = $1', [u.id]);
          }
          return json(res, 200, { id: u.id });
        }
        if (req.method === 'POST' && url.pathname === '/auth/v1/token') {
          if (req.headers.apikey !== ANON) return json(res, 401, { msg: 'invalid api key' });
          const grant = url.searchParams.get('grant_type');
          if (grant === 'password') {
            const u = [...users.values()].find((x) => x.email === body.email);
            if (!u || u.password !== body.password) return json(res, 400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
            if (!u.confirmed) return json(res, 400, { code: 400, error_code: 'email_not_confirmed', msg: 'Email not confirmed' });
            const rt = randomUUID();
            sessions.set(rt, u.id);
            return json(res, 200, { access_token: `access.${u.id}.x`, refresh_token: rt, expires_in: 3600, user: { id: u.id } });
          }
          if (grant === 'refresh_token') {
            const uid = sessions.get(body.refresh_token);
            if (!uid) return json(res, 400, { code: 400, error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token' });
            sessions.delete(body.refresh_token); // rotation
            const rt = randomUUID();
            sessions.set(rt, uid);
            return json(res, 200, { access_token: `access.${uid}.y`, refresh_token: rt, expires_in: 3600, user: { id: uid } });
          }
        }
        if (req.method === 'POST' && url.pathname === '/auth/v1/logout') return res.writeHead(204).end();
        json(res, 404, { msg: 'not found' });
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await pool.query('delete from auth.users where email = any($1)', [created]);
    await pool.query('delete from public.otp_codes where email = any($1)', [created]);
    await pool.query('delete from public.login_events where email = any($1)', [created]);
    await pool.end();
  });
  beforeEach(() => {
    seen.length = 0;
  });

  const identity = () => new SupabaseIdentity(baseUrl, SERVICE, ANON, pool);
  const ctx = { ip: '203.0.113.9', userAgent: 'test' };

  it('uses the service-role key only for admin calls and the anon key for sign-in/refresh', async () => {
    const id = identity();
    const email = `sb-${Date.now()}@example.com`;
    const { id: userId } = await id.createUser({ email, password: 'Pass-word-123', fullName: 'Sb User' });
    await id.markEmailVerified(userId);
    const signed = await id.signIn(email, 'Pass-word-123', ctx);
    assert.equal(signed.kind, 'ok');
    const admin = seen.filter((s) => s.url.startsWith('/auth/v1/admin/'));
    const token = seen.filter((s) => s.url.startsWith('/auth/v1/token'));
    assert.ok(admin.length >= 2 && admin.every((s) => s.apikey === SERVICE && s.auth === `Bearer ${SERVICE}`));
    assert.ok(token.length >= 1 && token.every((s) => s.apikey === ANON && s.auth === `Bearer ${ANON}`), 'sign-in must never carry the service key');
  });

  it('creates accounts UNCONFIRMED: sign-in is refused until the email is verified', async () => {
    const id = identity();
    const email = `sb2-${Date.now()}@example.com`;
    const { id: userId } = await id.createUser({ email, password: 'Pass-word-123', fullName: 'Sb User' });
    assert.deepEqual(await id.signIn(email, 'Pass-word-123', ctx), { kind: 'unverified' });
    await id.markEmailVerified(userId);
    assert.equal((await id.signIn(email, 'Pass-word-123', ctx)).kind, 'ok');
  });

  it('maps errors: wrong password, duplicate email, rotated refresh token', async () => {
    const id = identity();
    const email = `sb3-${Date.now()}@example.com`;
    const { id: userId } = await id.createUser({ email, password: 'Pass-word-123', fullName: 'X Y' });
    await id.markEmailVerified(userId);
    assert.deepEqual(await id.signIn(email, 'wrong', ctx), { kind: 'bad_credentials' });
    await assert.rejects(id.createUser({ email, password: 'Pass-word-123', fullName: 'X Y' }), /already registered/);
    const s = await id.signIn(email, 'Pass-word-123', ctx);
    assert.equal(s.kind, 'ok');
    if (s.kind !== 'ok') return;
    const next = await id.refresh(s.session.refreshToken, ctx);
    assert.ok(next && next.refreshToken !== s.session.refreshToken);
    assert.equal(await id.refresh(s.session.refreshToken, ctx), null, 'old refresh token is dead');
    assert.equal(await id.refresh('garbage', ctx), null);
  });

  it('surfaces provider outages instead of pretending credentials were wrong', async () => {
    const down = new SupabaseIdentity('http://127.0.0.1:1', SERVICE, ANON, pool, 500);
    await assert.rejects(down.signIn('a@b.co', 'x', ctx));
  });

  it('end to end through the HTTP API: signup → OTP email → verify → login → refresh → logout', async () => {
    const mail = new MemoryTransport();
    const cfg = { ...testApiConfig(), authProvider: 'supabase' as const, SUPABASE_URL: baseUrl, SUPABASE_SERVICE_ROLE_KEY: SERVICE, SUPABASE_ANON_KEY: ANON };
    const { app } = createApp({ config: cfg, pool, queue: new FakeQueue(), logger: createLogger('silent'), policy: { allowPrivateTargets: false }, emailTransport: mail });
    const srv = await new Promise<http.Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const api = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    const email = `sb-e2e-${Date.now()}@example.com`;
    const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
      const r = await fetch(api + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
      return { status: r.status, body: await r.json().catch(() => null), headers: r.headers };
    };
    try {
      await pool.query('delete from public.auth_attempts');
      const su = await post('/api/auth/signup', { fullName: 'Sb Flow', email, password: 'Flow-pass-123', confirmPassword: 'Flow-pass-123', termsAccepted: true });
      assert.equal(su.status, 202);
      assert.equal((await post('/api/auth/login', { email, password: 'Flow-pass-123' })).body.error.code, 'email_not_verified');
      assert.equal((await post('/api/auth/verify-otp', { email, code: mail.codeFor(email) })).status, 200);
      const li = await post('/api/auth/login', { email, password: 'Flow-pass-123' });
      assert.equal(li.status, 200);
      assert.match(li.headers.get('set-cookie') ?? '', /nba_rt=.*HttpOnly/i);
      const cookie = (li.headers.get('set-cookie') ?? '').split(';')[0]!;
      const rf = await post('/api/auth/refresh', {}, { cookie, 'x-requested-with': 'nba-web' });
      assert.equal(rf.status, 200);
      assert.equal((await post('/api/auth/logout', {}, { cookie: (rf.headers.get('set-cookie') ?? '').split(';')[0]!, 'x-requested-with': 'nba-web' })).status, 204);
    } finally {
      srv.closeAllConnections();
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });
});

describe('configuration safety', () => {
  const base = {
    NODE_ENV: 'production', REDIS_URL: 'redis://x', DATABASE_URL: 'postgres://x', SESSION_SECRET: 'x'.repeat(40),
    SUPABASE_URL: 'https://p.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 's', SUPABASE_ANON_KEY: 'a', RESEND_API_KEY: 'r', EMAIL_FROM: 'NBA <no-reply@example.com>',
  };
  it('accepts a complete production configuration', () => assert.equal(loadConfig(base as never).authProvider, 'supabase'));
  it('refuses the local identity provider in production', () => assert.throws(() => loadConfig({ ...base, AUTH_PROVIDER: 'local', SUPABASE_JWT_SECRET: 'y'.repeat(32) } as never), /development and tests only/));
  it('refuses production without an email provider', () => {
    assert.throws(() => loadConfig({ ...base, RESEND_API_KEY: undefined } as never), /RESEND_API_KEY/);
    assert.throws(() => loadConfig({ ...base, EMAIL_FROM: undefined } as never), /EMAIL_FROM/);
  });
  it('refuses a weak or missing session secret', () => {
    assert.throws(() => loadConfig({ ...base, SESSION_SECRET: 'short' } as never), /SESSION_SECRET/);
    assert.throws(() => loadConfig({ ...base, SESSION_SECRET: undefined } as never), /SESSION_SECRET/);
  });
  it('refuses the supabase provider without its keys', () => assert.throws(() => loadConfig({ ...base, AUTH_PROVIDER: 'supabase', SUPABASE_SERVICE_ROLE_KEY: undefined } as never), /SUPABASE_SERVICE_ROLE_KEY/));
  it('refuses to build the app with the local provider in production', () => {
    const cfg = { ...testApiConfig(), NODE_ENV: 'production' as const };
    assert.throws(() => createApp({ config: cfg, pool: {} as never, queue: new FakeQueue(), logger: createLogger('silent'), policy: { allowPrivateTargets: false } }), /must not be used in production/);
  });
});
