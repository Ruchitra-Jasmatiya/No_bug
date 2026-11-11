import http from 'node:http';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { resolveModules, type ModuleId } from '@nba/shared';
import type { WorkerConfig } from '../src/config.js';
import { createLogger } from '../src/lib/logger.js';
import { Store } from '../src/lib/store.js';

export const DB_URL = process.env.TEST_DATABASE_URL;

export function testConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    REDIS_URL: 'redis://127.0.0.1:6390',
    WORKER_CONCURRENCY: 1,
    HEARTBEAT_INTERVAL_MS: 200,
    STALE_AFTER_MS: 1500,
    REAPER_INTERVAL_MS: 500,
    LOCK_DURATION_MS: 3000,
    STALLED_INTERVAL_MS: 1000,
    workerId: 'test-worker-1',
    databaseUrl: DB_URL ?? '',
    CHROME_EXECUTABLE_PATH: process.env.CHROME_EXECUTABLE_PATH,
    ...overrides,
  } as WorkerConfig;
}

export const silentLogger = createLogger('silent');

/** A deliberately buggy website, so the tests can assert that real problems are really detected. */
export async function startFixtureSite(): Promise<{ base: string; hits: Map<string, number>; release: () => void; close: () => Promise<void> }> {
  const hits = new Map<string, number>();
  // "/gated" sends its headers immediately but holds the body until release() is called.
  let gateOpen = false;
  const waiting: http.ServerResponse[] = [];
  const release = (): void => {
    gateOpen = true;
    for (const r of waiting.splice(0)) {
      try {
        r.end('<h1>Gated page</h1></body></html>');
      } catch {
        /* client gone */
      }
    }
  };
  const server = http.createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    hits.set(path, (hits.get(path) ?? 0) + 1);
    switch (path) {
      case '/':
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(`<!doctype html><html lang="en"><head><title>Fixture Shop</title>
<link rel="stylesheet" href="/missing.css"></head>
<body><h1>Fixture</h1>
<script src="/app.js"></script>
<script>console.error('Boom from inline script'); console.warn('Deprecated thing');</script>
<script>setTimeout(function(){ undefinedFunction(); }, 20);</script>
<img src="/missing.png" alt="x">
</body></html>`);
        break;
      case '/app.js':
        res.writeHead(200, { 'content-type': 'application/javascript' });
        res.end('window.appLoaded = true;');
        break;
      case '/buggy':
        res.writeHead(200, { 'content-type': 'text/html', 'x-powered-by': 'Express 4.17.1', 'set-cookie': 'sessionid=abc123; Path=/' });
        res.end(`<!doctype html><html><head><title>Hi</title></head>
<body><h1>One</h1><h1>Two</h1><h4>Skipped level</h4>
<img src="/pic.png"><img src="/missing-pic.png" alt="">
<div style="width:2400px;background:#eee">very wide block</div>
<button id="empty"></button>
<button id="boom" onclick="nope.nothing()">Do it</button>
<button id="danger">Delete everything</button>
<form action="/x"><input name="email"><input type="text" name="q"></form>
<a href="/missing-page">Gone</a><a href="#">Nowhere</a><a href="/clean">Fine</a>
<script>navigator.geolocation.getCurrentPosition(function(){});</script>
<script>fetch('/api/data'); fetch('/api/bad'); fetch('/api/err');</script>
</body></html>`);
        break;
      case '/good':
        res.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'", 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' });
        res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>A well made example page</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="A tidy example page used to check that the testing tool does not invent problems where there are none.">
<link rel="canonical" href="/good">
<meta property="og:title" content="Good"><meta property="og:description" content="d"><meta property="og:image" content="/i.png">
<style>body{font-family:sans-serif;margin:0;padding:16px;max-width:100%}button,input{min-height:44px;min-width:44px;box-sizing:border-box}a{color:#003}</style></head>
<body><main><h1>Good page</h1><p>Some readable text content here.</p>
<form action="/x"><label for="q">Search</label> <input id="q" name="q"><button type="submit">Go</button></form>
<a href="/clean">Clean page</a></main></body></html>`);
        break;
      case '/api/data':
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
        break;
      case '/api/bad':
        res.writeHead(200, { 'content-type': 'application/json' }).end('{not json');
        break;
      case '/api/err':
        res.writeHead(500, { 'content-type': 'application/json' }).end('{"error":"boom"}');
        break;
      case '/.env':
        res.writeHead(200, { 'content-type': 'text/plain' }).end('SECRET_KEY=abc123\nDB_PASSWORD=hunter2\n');
        break;
      case '/.git/HEAD':
        res.writeHead(200, { 'content-type': 'text/plain' }).end('ref: refs/heads/main\n');
        break;
      case '/pic.png':
        res.writeHead(200, { 'content-type': 'image/png' }).end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));
        break;
      case '/robots.txt':
        res.writeHead(200, { 'content-type': 'text/plain' }).end('User-agent: *\nDisallow: /private\n');
        break;
      case '/api-json':
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"not":"html"}');
        break;
      case '/clean':
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<!doctype html><html lang="en"><head><title>Clean page</title></head><body><h1>All good</h1></body></html>');
        break;
      case '/leaky':
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<!doctype html><title>Leaky</title><body><script src="http://127.0.0.1:1/dev-bundle.js"></script></body>');
        break;
      case '/gated':
        res.writeHead(200, { 'content-type': 'text/html' });
        res.write('<!doctype html><html lang="en"><head><title>Gated page</title></head><body>');
        if (gateOpen) res.end('<h1>Gated page</h1></body></html>');
        else waiting.push(res);
        break;
      case '/error500':
        res.writeHead(500, { 'content-type': 'text/html' }).end('<h1>Server exploded</h1>');
        break;
      case '/slow':
        setTimeout(() => res.writeHead(200, { 'content-type': 'text/html' }).end('<title>slow</title>'), 60_000).unref();
        break;
      default:
        res.writeHead(404, { 'content-type': 'text/html' }).end('<h1>Not found</h1>');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    hits,
    release,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export interface TestDb {
  pool: pg.Pool;
  store: Store;
  userId: string;
  createJob(url: string, modules?: ModuleId[]): Promise<string>;
  cleanup(): Promise<void>;
}

export async function setupDb(): Promise<TestDb> {
  const pool = new pg.Pool({ connectionString: DB_URL, max: 6 });
  const store = new Store(pool);
  const tag = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  const user = await pool.query<{ id: string }>(`insert into auth.users (email, email_confirmed_at) values ($1, now()) returning id`, [`worker-test+${tag}@example.com`]);
  const userId = user.rows[0]!.id;
  const created: string[] = [];
  return {
    pool,
    store,
    userId,
    async createJob(url, modules) {
      const u = new URL(url);
      const project = await pool.query<{ id: string }>(
        `insert into public.test_projects (user_id, name, base_url, hostname) values ($1,$2,$3,$4)
         on conflict (user_id, base_url) do update set name = excluded.name returning id`,
        [userId, u.hostname, u.origin + '/', u.hostname],
      );
      const job = await pool.query<{ id: string }>(
        `insert into public.test_jobs (project_id, user_id, target_url, hostname, selected_modules) values ($1,$2,$3,$4,$5) returning id`,
        [project.rows[0]!.id, userId, url, u.hostname, resolveModules(modules)],
      );
      created.push(job.rows[0]!.id);
      return job.rows[0]!.id;
    },
    async cleanup() {
      await pool.query('delete from auth.users where id = $1', [userId]);
      await pool.end();
    },
  };
}
