import type { AddressInfo } from 'node:net';
import { SignJWT } from 'jose';
import pg from 'pg';
import type { NetPolicy, Resolver } from '@nba/shared/net';
import { createApp } from '../src/app.js';
import type { ApiConfig } from '../src/config.js';
import { createLogger } from '../src/lib/logger.js';
import { MemoryTransport } from '../src/email/transports.js';
import type { JobQueue } from '../src/queue/queue.js';

export const DB_URL = process.env.TEST_DATABASE_URL;
export const JWT_SECRET = 'test-secret-test-secret-test-secret-123';

export class FakeQueue implements JobQueue {
  enqueued: string[] = [];
  removed: string[] = [];
  fail = false;
  async enqueue(id: string) {
    if (this.fail) throw new Error('redis down');
    this.enqueued.push(id);
  }
  async remove(id: string) {
    this.removed.push(id);
  }
  async ping() {
    return true;
  }
  async close() {}
}

export function testApiConfig(over: Partial<ApiConfig> = {}): ApiConfig {
  return {
    NODE_ENV: 'test',
    PORT: 0,
    LOG_LEVEL: 'silent',
    REDIS_URL: 'redis://127.0.0.1:6390',
    SUPABASE_JWT_SECRET: JWT_SECRET,
    CORS_ORIGINS: 'http://localhost:5173',
    TRUST_PROXY: 0,
    SESSION_SECRET: 'test-session-secret-test-session-secret-0123456789',
    authProvider: 'local',
    databaseUrl: DB_URL ?? '',
    corsOrigins: ['http://localhost:5173'],
    ...over,
  } as ApiConfig;
}

export async function token(userId: string, over: { aud?: string; exp?: string | number; secret?: string } = {}): Promise<string> {
  return new SignJWT({ role: 'authenticated' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setAudience(over.aud ?? 'authenticated')
    .setIssuedAt()
    .setExpirationTime(over.exp ?? '1h')
    .sign(new TextEncoder().encode(over.secret ?? JWT_SECRET));
}

export interface TestApi {
  base: string;
  pool: pg.Pool;
  queue: FakeQueue;
  mail: MemoryTransport;
  close(): Promise<void>;
  call(method: string, path: string, opts?: { userId?: string; token?: string; body?: unknown; headers?: Record<string, string> }): Promise<{ status: number; body: any; headers: Headers }>;
  makeUser(opts?: { admin?: boolean; suspended?: boolean }): Promise<string>;
  cleanup(): Promise<void>;
}

export async function startApi(opts: { policy?: NetPolicy; resolver?: Resolver; ai?: import('@nba/shared/ai').AiProvider | null; config?: Partial<ApiConfig> } = {}): Promise<TestApi> {
  const pool = new pg.Pool({ connectionString: DB_URL, max: 8 });
  const queue = new FakeQueue();
  const mail = new MemoryTransport();
  const policy = opts.policy ?? { allowPrivateTargets: false };
  const resolver: Resolver = opts.resolver ?? (async () => [{ address: '93.184.216.34', family: 4 }]);
  const { app } = createApp({ config: testApiConfig(opts.config), pool, queue, logger: createLogger('silent'), policy, resolver, emailTransport: mail, ai: opts.ai ?? null });
  const server = await new Promise<import('node:http').Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const users: string[] = [];

  return {
    base,
    pool,
    queue,
    mail,
    async call(method, path, o = {}) {
      const headers: Record<string, string> = { ...(o.headers ?? {}) };
      const tk = o.token ?? (o.userId ? await token(o.userId) : undefined);
      if (tk) headers.authorization = `Bearer ${tk}`;
      let body: string | undefined;
      if (o.body !== undefined) {
        body = typeof o.body === 'string' ? o.body : JSON.stringify(o.body);
        headers['content-type'] ??= 'application/json';
      }
      const res = await fetch(base + path, { method, headers, body });
      const text = await res.text();
      let parsed: any = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = text;
      }
      return { status: res.status, body: parsed, headers: res.headers };
    },
    async makeUser(o = {}) {
      const tag = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
      const r = await pool.query<{ id: string }>(`insert into auth.users (email, raw_user_meta_data, email_confirmed_at) values ($1,$2,now()) returning id`, [`api-test+${tag}@example.com`, JSON.stringify({ full_name: 'Test User' })]);
      const id = r.rows[0]!.id;
      users.push(id);
      if (o.admin) await pool.query(`insert into public.user_roles (user_id, role) values ($1,'admin')`, [id]);
      if (o.suspended) await pool.query(`update public.profiles set account_status = 'suspended' where id = $1`, [id]);
      return id;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
    async cleanup() {
      if (users.length) await pool.query('delete from auth.users where id = any($1)', [users]);
      await pool.end();
    },
  };
}
