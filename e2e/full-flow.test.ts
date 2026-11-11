/**
 * Full-system tests: API → Redis/BullMQ → REAL worker OS process → Chromium → Postgres → report.
 *   TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:54329/nba_test TEST_REDIS_URL=redis://127.0.0.1:6390 npm run test:e2e
 * Skipped (never "passed") when no database / redis is configured.
 */
import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { Redis } from 'ioredis';
import pg from 'pg';
import { createApp } from '../api/src/app.js';
import { createLogger } from '../api/src/lib/logger.js';
import { createJobQueue } from '../api/src/queue/queue.js';
import { JWT_SECRET, testApiConfig, token } from '../api/test/helpers.js';
import { startFixtureSite } from '../worker/test/helpers.js';

const DB = process.env.TEST_DATABASE_URL;
const REDIS = process.env.TEST_REDIS_URL;
const suite = DB && REDIS ? describe : describe.skip;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

suite('full system (API → queue → worker process → report)', () => {
  const pool = new pg.Pool({ connectionString: DB, max: 6 });
  let site: Awaited<ReturnType<typeof startFixtureSite>>;
  let server: import('node:http').Server;
  let base: string;
  let userId: string;
  let queue: ReturnType<typeof createJobQueue>;
  const workers = new Map<string, ChildProcess>();

  async function api(method: string, path: string, body?: unknown) {
    const res = await fetch(base + path, {
      method,
      headers: { authorization: `Bearer ${await token(userId)}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: (await res.json()) as any };
  }

  function startWorker(id: string): ChildProcess {
    const child = spawn(process.execPath, ['--import', 'tsx', 'worker/src/main.ts'], {
      cwd: new URL('..', import.meta.url).pathname,
      detached: true, // own process group, so a "crash" takes Chromium down with it
      stdio: 'ignore',
      env: {
        ...process.env,
        NODE_ENV: 'test',
        NBA_ALLOW_PRIVATE_TARGETS: 'true',
        SUPABASE_DB_URL: DB,
        REDIS_URL: REDIS,
        WORKER_ID: id,
        LOG_LEVEL: 'silent',
        HEARTBEAT_INTERVAL_MS: '300',
        STALE_AFTER_MS: '2500',
        REAPER_INTERVAL_MS: '700',
        LOCK_DURATION_MS: '3000',
        STALLED_INTERVAL_MS: '1000',
        WORKER_CONCURRENCY: '1',
      },
    });
    workers.set(id, child);
    return child;
  }
  function killHard(id: string): void {
    const c = workers.get(id);
    if (c?.pid) {
      try {
        process.kill(-c.pid, 'SIGKILL'); // the whole group: node + chromium
      } catch {
        /* already gone */
      }
    }
    workers.delete(id);
  }
  async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, ms: number, what: string): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await sleep(150);
    }
  }
  const jobRow = async (id: string) => (await pool.query('select * from public.test_jobs where id = $1', [id])).rows[0];
  const mods = async (id: string) => (await pool.query('select * from public.test_modules where job_id = $1 order by position', [id])).rows;

  before(async () => {
    site = await startFixtureSite();
    queue = createJobQueue(REDIS!);
    const { app } = createApp({ config: testApiConfig({ REDIS_URL: REDIS! }), pool, queue, logger: createLogger('silent'), policy: { allowPrivateTargets: true } });
    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const u = await pool.query<{ id: string }>(`insert into auth.users (email, email_confirmed_at) values ($1, now()) returning id`, [`e2e+${Date.now()}@example.com`]);
    userId = u.rows[0]!.id;
    void JWT_SECRET;
    const r = new Redis(REDIS!);
    await r.flushdb();
    await r.quit();
  });

  after(async () => {
    for (const id of [...workers.keys()]) killHard(id);
    server?.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await queue.close();
    await site.close();
    await pool.query('delete from auth.users where id = $1', [userId]);
    await pool.end();
  });

  it('happy path: submit a URL, watch real progress, get a real report', async () => {
    startWorker('w-happy');
    const created = await api('POST', '/api/tests', { url: `${site.base}/`, authorizationConfirmed: true });
    assert.equal(created.status, 202);
    const id = created.body.job.id as string;

    const seen = new Set<number>();
    const progressOf = async () => (await api('GET', `/api/tests/${id}/progress`)).body;
    let last: any;
    await waitFor(async () => {
      last = await progressOf();
      seen.add(last.job.progressPct);
      return last.job.status === 'completed' ? last : null;
    }, 90_000, 'job completion');
    killHard('w-happy');

    assert.equal(last.job.progressPct, 100);
    assert.ok(last.modules.every((m: any) => ['completed', 'skipped'].includes(m.status)));
    assert.ok(last.logs.length > 3);

    const report = (await api('GET', `/api/tests/${id}/report`)).body;
    assert.equal(report.summary.overall, 'issues_found');
    assert.match(report.message, /issues? detected in the tests performed/);
    const titles = report.results.map((r: any) => `${r.checkKey}:${r.status}`);
    assert.ok(titles.includes('browser_launch:pass'));
    assert.ok(report.results.some((r: any) => /^exception_/.test(r.checkKey) && /undefinedFunction/.test(r.message)));
    assert.ok(report.bugs.length >= 5);
    assert.ok(report.bugs.every((b: any) => b.issueCode && b.suggestedFix && b.aiAnalysis === null));
    // modules that do not exist yet are reported as skipped, never as passed
    const perf = report.modules.find((m: any) => m.moduleId === 'ai_analysis');
    assert.equal(perf.status, 'skipped');
  });

  it('SURVIVES A WORKER CRASH: SIGKILL mid-module, a second worker resumes, finished modules are not rerun', async () => {
    startWorker('w-crash-1');
    const created = await api('POST', '/api/tests', { url: `${site.base}/gated`, authorizationConfirmed: true });
    const id = created.body.job.id as string;

    // Wait until it is genuinely inside page_inspection (connectivity and browser launch already done).
    await waitFor(async () => {
      const m = await mods(id);
      return m.find((x) => x.module_id === 'page_inspection')?.status === 'running' ? true : null;
    }, 60_000, 'page_inspection to start');
    const before = await mods(id);
    assert.equal(before.find((m) => m.module_id === 'connectivity').status, 'completed');
    assert.equal(before.find((m) => m.module_id === 'browser_launch').status, 'completed');

    killHard('w-crash-1'); // power-cut: no cleanup runs
    await sleep(300);
    assert.equal((await jobRow(id)).status, 'running', 'the database still says running; nothing cleaned up');

    site.release(); // the page can now load for whoever retries
    startWorker('w-crash-2');

    const done = await waitFor(async () => {
      const j = await jobRow(id);
      return j.status === 'completed' ? j : null;
    }, 90_000, 'recovery to complete the job');

    assert.ok(done.attempt >= 2);
    const after = await mods(id);
    const by = (m: string) => after.find((x) => x.module_id === m);
    assert.equal(by('connectivity').attempt, 1, 'connectivity was NOT rerun');
    assert.equal(by('browser_launch').attempt, 1, 'browser launch was NOT rerun');
    assert.equal(by('page_inspection').attempt, 2, 'only the interrupted module was retried');
    assert.equal(by('page_inspection').status, 'completed');

    const results = (await pool.query('select check_key, status, evidence from public.test_results where job_id = $1', [id])).rows;
    const load = results.find((r) => r.check_key === 'page_load');
    assert.equal(load.status, 'pass');
    assert.equal(load.evidence.title, 'Gated page');
    const keys = results.map((r) => `${r.check_key}`);
    assert.equal(new Set(keys).size, keys.length, 'no duplicated results after recovery');
    const logs = (await pool.query('select message from public.test_logs where job_id = $1', [id])).rows.map((r) => r.message as string);
    assert.ok(logs.some((l) => /Resuming test/.test(l)));
    killHard('w-crash-2');
  });

  it('survives a lost queue: Redis wiped before any worker picked the job up', async () => {
    const created = await api('POST', '/api/tests', { url: `${site.base}/clean`, authorizationConfirmed: true });
    const id = created.body.job.id as string;
    const r = new Redis(REDIS!);
    await r.flushdb(); // the queue message is gone; the database row is not
    await r.quit();
    assert.equal((await jobRow(id)).status, 'queued');

    startWorker('w-reaper');
    await waitFor(async () => ((await jobRow(id)).status === 'completed' ? true : null), 90_000, 'reaper to re-enqueue and complete the job');
    killHard('w-reaper');
  });

  it('cancels a running test through the API; the worker stops it promptly', async () => {
    site.release(); // not used here; /slow never answers
    startWorker('w-cancel');
    const created = await api('POST', '/api/tests', { url: `${site.base}/slow`, authorizationConfirmed: true });
    const id = created.body.job.id as string;
    await waitFor(async () => ((await jobRow(id)).status === 'running' ? true : null), 30_000, 'job to start');
    const c = await api('POST', `/api/tests/${id}/cancel`);
    assert.equal(c.status, 200);
    const j = await waitFor(async () => {
      const row = await jobRow(id);
      return row.status === 'cancelled' ? row : null;
    }, 30_000, 'cancellation');
    assert.ok(j.finished_at);
    const report = await api('GET', `/api/tests/${id}/report`);
    assert.equal(report.status, 200);
    assert.match(report.body.message, /cancelled/);
    killHard('w-cancel');
  });
});
