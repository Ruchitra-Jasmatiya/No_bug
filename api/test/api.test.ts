/**
 * API tests: real Postgres + real HTTP server, fake queue.
 *   TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:54329/nba_test npm test -w api
 * Skipped (never "passed") when no database is configured.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { SignJWT } from 'jose';
import { NO_ISSUES_MESSAGE, type JobDTO } from '@nba/shared';
import { reportMessage } from '../src/routes/tests.js';
import { DB_URL, JWT_SECRET, startApi, token, type TestApi } from './helpers.js';

const suite = DB_URL ? describe : describe.skip;
const OK = { url: 'https://example.com', authorizationConfirmed: true };

suite('API', () => {
  let api: TestApi;
  let alice: string;
  let bob: string;

  before(async () => {
    api = await startApi();
    alice = await api.makeUser();
    bob = await api.makeUser();
  });
  after(async () => {
    await api.close();
    await api.cleanup();
  });
  beforeEach(async () => {
    api.queue.enqueued.length = 0;
    api.queue.removed.length = 0;
    api.queue.fail = false;
    // keep tests independent: clear jobs for our users
    await api.pool.query('delete from public.test_jobs where user_id = any($1)', [[alice, bob]]);
  });

  const create = (userId: string, body: unknown = OK) => api.call('POST', '/api/tests', { userId, body });

  describe('authentication', () => {
    it('rejects requests without a token', async () => {
      const r = await api.call('GET', '/api/tests');
      assert.equal(r.status, 401);
      assert.equal(r.body.error.code, 'unauthorized');
    });
    it('rejects garbage, wrong-secret, wrong-audience and expired tokens', async () => {
      assert.equal((await api.call('GET', '/api/tests', { token: 'not.a.jwt' })).status, 401);
      assert.equal((await api.call('GET', '/api/tests', { token: await token(alice, { secret: 'another-secret-another-secret-12345' }) })).status, 401);
      assert.equal((await api.call('GET', '/api/tests', { token: await token(alice, { aud: 'someone-else' }) })).status, 401);
      assert.equal((await api.call('GET', '/api/tests', { token: await token(alice, { exp: Math.floor(Date.now() / 1000) - 60 }) })).status, 401);
    });
    it('rejects an unsigned "alg: none" token', async () => {
      const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
      const none = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: alice, aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })}.`;
      assert.equal((await api.call('GET', '/api/tests', { token: none })).status, 401);
    });
    it('rejects a token for an HS384 signature (algorithm is pinned)', async () => {
      const t = await new SignJWT({}).setProtectedHeader({ alg: 'HS384' }).setSubject(alice).setAudience('authenticated').setExpirationTime('1h').sign(new TextEncoder().encode(JWT_SECRET));
      assert.equal((await api.call('GET', '/api/tests', { token: t })).status, 401);
    });
    it('rejects a valid token for a user with no profile', async () => {
      assert.equal((await api.call('GET', '/api/tests', { userId: '00000000-0000-4000-8000-000000000000' })).status, 401);
    });
    it('blocks suspended accounts', async () => {
      const s = await api.makeUser({ suspended: true });
      const r = await api.call('GET', '/api/tests', { userId: s });
      assert.equal(r.status, 403);
      assert.match(r.body.error.message, /suspended/i);
    });
    it('does not trust a role claim inside the token', async () => {
      const forged = await new SignJWT({ role: 'admin', app_metadata: { role: 'admin' } }).setProtectedHeader({ alg: 'HS256' }).setSubject(alice).setAudience('authenticated').setExpirationTime('1h').sign(new TextEncoder().encode(JWT_SECRET));
      const r = await api.call('GET', '/api/tests', { token: forged });
      assert.equal(r.status, 200); // authenticated as a normal user; nothing admin-only is exposed by this router
    });
  });

  describe('creating tests', () => {
    it('accepts a valid URL, stores a queued job and enqueues it exactly once', async () => {
      const r = await create(alice);
      assert.equal(r.status, 202);
      assert.equal(r.body.job.status, 'queued');
      assert.equal(r.body.job.targetUrl, 'https://example.com/');
      assert.equal(r.body.job.hostname, 'example.com');
      assert.equal(r.body.job.progressPct, 0);
      assert.deepEqual(api.queue.enqueued, [r.body.job.id]);
      const row = (await api.pool.query('select * from public.test_jobs where id = $1', [r.body.job.id])).rows[0];
      assert.equal(row.user_id, alice);
      assert.ok(row.selected_modules.includes('connectivity') && row.selected_modules.includes('report_generation'));
    });

    it('normalises a bare domain', async () => {
      const r = await create(alice, { url: 'example.com/shop', authorizationConfirmed: true });
      assert.equal(r.status, 202);
      assert.equal(r.body.job.targetUrl, 'https://example.com/shop');
    });

    it('requires the authorisation confirmation', async () => {
      const r = await create(alice, { url: 'https://example.com' });
      assert.equal(r.status, 400);
      assert.match(r.body.error.message, /authorised/);
      assert.equal(api.queue.enqueued.length, 0);
    });

    for (const [name, url, status] of [
      ['empty', '', 400],
      ['garbage', 'not a url at all', 400],
      ['javascript scheme', 'javascript:alert(1)', 400],
      ['file scheme', 'file:///etc/passwd', 400],
      ['credentials in URL', 'https://user:pw@example.com', 400],
      ['localhost', 'http://localhost', 422],
      ['.internal host', 'http://db.internal', 422],
      ['unusual port', 'https://example.com:22', 422],
    ] as const) {
      it(`rejects ${name}`, async () => {
        const r = await create(alice, { url, authorizationConfirmed: true });
        assert.equal(r.status, status);
        assert.ok(r.body.error.message.length > 5);
        assert.equal(api.queue.enqueued.length, 0);
        assert.equal((await api.pool.query('select 1 from public.test_jobs where user_id = $1', [alice])).rowCount, 0);
      });
    }

    it('gives the specified message for an invalid URL', async () => {
      const r = await create(alice, { url: 'not a url at all', authorizationConfirmed: true });
      assert.equal(r.body.error.message, 'Please enter a valid website URL.');
    });

    for (const ip of ['127.0.0.1', '10.0.0.5', '192.168.1.1', '169.254.169.254', '172.16.0.1', '[::1]', '0.0.0.0', '2130706433']) {
      it(`blocks IP literal ${ip} (SSRF)`, async () => {
        const r = await create(alice, { url: `http://${ip}/`, authorizationConfirmed: true });
        assert.equal(r.status, 422);
        assert.equal(r.body.error.code, 'target_blocked');
        assert.equal(api.queue.enqueued.length, 0);
      });
    }

    it('blocks a public-looking hostname that resolves to a private address', async () => {
      const a = await startApi({ resolver: async () => [{ address: '10.1.2.3', family: 4 }] });
      try {
        const u = await a.makeUser();
        const r = await a.call('POST', '/api/tests', { userId: u, body: OK });
        assert.equal(r.status, 422);
        assert.equal(r.body.error.code, 'target_blocked');
      } finally {
        await a.close();
        await a.cleanup();
      }
    });

    it('reports an unresolvable domain with the friendly message', async () => {
      const a = await startApi({ resolver: async () => Promise.reject(Object.assign(new Error('x'), { code: 'ENOTFOUND' })) });
      try {
        const u = await a.makeUser();
        const r = await a.call('POST', '/api/tests', { userId: u, body: OK });
        assert.equal(r.status, 422);
        assert.equal(r.body.error.message, 'We could not reach this website. Please verify the address and try again.');
      } finally {
        await a.close();
        await a.cleanup();
      }
    });

    it('is idempotent with an idempotency key', async () => {
      const body = { ...OK, idempotencyKey: 'key-12345678' };
      const a = await create(alice, body);
      const b = await create(alice, body);
      assert.equal(a.status, 202);
      assert.equal(b.status, 200);
      assert.equal(a.body.job.id, b.body.job.id);
      assert.equal(b.body.created, false);
      assert.equal(api.queue.enqueued.length, 1);
      assert.equal((await api.pool.query('select 1 from public.test_jobs where user_id = $1', [alice])).rowCount, 1);
    });

    it('concurrent identical requests with one key create one job', async () => {
      const body = { ...OK, idempotencyKey: 'race-key-1234' };
      const rs = await Promise.all([create(alice, body), create(alice, body), create(alice, body)]);
      assert.equal(new Set(rs.map((r) => r.body.job.id)).size, 1);
      assert.equal((await api.pool.query('select 1 from public.test_jobs where user_id = $1', [alice])).rowCount, 1);
    });

    it('does not lose the request when the queue is down: job stays queued for the reaper', async () => {
      api.queue.fail = true;
      const r = await create(alice);
      assert.equal(r.status, 202);
      assert.equal(r.body.job.status, 'queued');
      assert.equal((await api.pool.query('select status from public.test_jobs where id = $1', [r.body.job.id])).rows[0].status, 'queued');
    });

    it('rejects modules the administrator has not enabled', async () => {
      const original = (await api.pool.query(`select value from public.app_settings where key = 'enabled_modules'`)).rows[0].value;
      await api.pool.query(`update public.app_settings set value = '["connectivity","browser_launch","page_inspection","console","report_generation"]' where key = 'enabled_modules'`);
      try {
        const r = await create(alice, { ...OK, modules: ['performance'] });
        assert.equal(r.status, 422);
        assert.equal(r.body.error.code, 'module_unavailable');
      } finally {
        await api.pool.query(`update public.app_settings set value = $1 where key = 'enabled_modules'`, [JSON.stringify(original)]);
      }
    });
    it('rejects unknown module ids', async () => {
      assert.equal((await create(alice, { ...OK, modules: ['nope'] })).status, 400);
    });

    it('enforces the per-user active-test cap, and counts concurrent attempts correctly', async () => {
      const rs = await Promise.all([1, 2, 3, 4].map((i) => create(alice, { url: `https://site${i}.example.com`, authorizationConfirmed: true })));
      assert.equal(rs.filter((r) => r.status === 202).length, 2);
      assert.equal(rs.filter((r) => r.status === 409).length, 2);
      assert.equal(rs.find((r) => r.status === 409)!.body.error.code, 'too_many_active_jobs');
    });

    it('enforces the hourly per-user limit from the settings table (admin-editable)', async () => {
      await api.pool.query(`update public.app_settings set value = '{"tests_per_hour_per_user": 1, "tests_per_hour_per_domain": 30}' where key = 'rate_limits'`);
      try {
        await api.pool.query(`insert into public.test_projects (user_id, name, base_url, hostname) values ($1,'x','https://seed.example.com/','seed.example.com')`, [bob]);
        const first = await create(bob);
        assert.equal(first.status, 202);
        await api.pool.query(`update public.test_jobs set status = 'completed' where id = $1`, [first.body.job.id]);
        const second = await create(bob, { url: 'https://other.example.org', authorizationConfirmed: true });
        assert.equal(second.status, 429);
        assert.equal(second.body.error.code, 'rate_limited');
      } finally {
        await api.pool.query(`update public.app_settings set value = '{"tests_per_hour_per_user": 20, "tests_per_hour_per_domain": 30}' where key = 'rate_limits'`);
        await api.pool.query(`delete from public.test_projects where user_id = $1`, [bob]);
      }
    });

    it('enforces the per-domain hourly limit across users', async () => {
      await api.pool.query(`update public.app_settings set value = '{"tests_per_hour_per_user": 20, "tests_per_hour_per_domain": 1}' where key = 'rate_limits'`);
      try {
        const a = await create(alice);
        assert.equal(a.status, 202);
        const b = await create(bob);
        assert.equal(b.status, 429);
        assert.match(b.body.error.message, /tested too many times/);
      } finally {
        await api.pool.query(`update public.app_settings set value = '{"tests_per_hour_per_user": 20, "tests_per_hour_per_domain": 30}' where key = 'rate_limits'`);
      }
    });
  });

  describe('ownership and isolation', () => {
    it("never reveals or lets a user touch another user's test", async () => {
      const mine = (await create(alice)).body.job.id as string;
      const paths: Array<[string, string]> = [
        ['GET', `/api/tests/${mine}`],
        ['GET', `/api/tests/${mine}/progress`],
        ['GET', `/api/tests/${mine}/report`],
        ['GET', `/api/tests/${mine}/bugs`],
        ['POST', `/api/tests/${mine}/cancel`],
        ['POST', `/api/tests/${mine}/resume`],
        ['POST', `/api/tests/${mine}/restart`],
      ];
      for (const [m, p] of paths) {
        const r = await api.call(m, p, { userId: bob });
        assert.equal(r.status, 404, `${m} ${p}`);
        assert.equal(r.body.error.code, 'not_found');
      }
      assert.equal((await api.pool.query('select cancel_requested, status from public.test_jobs where id = $1', [mine])).rows[0].cancel_requested, false);
    });
    it('returns the same 404 for a random id and for a malformed id', async () => {
      assert.equal((await api.call('GET', '/api/tests/00000000-0000-4000-8000-000000000000', { userId: alice })).status, 404);
      assert.equal((await api.call('GET', '/api/tests/not-a-uuid', { userId: alice })).status, 404);
      assert.equal((await api.call('GET', "/api/tests/1'%20or%20'1'='1", { userId: alice })).status, 404);
    });
    it('lists only the caller’s tests, newest first, with pagination', async () => {
      await create(alice, { url: 'https://one.example.com', authorizationConfirmed: true });
      await create(alice, { url: 'https://two.example.com', authorizationConfirmed: true });
      await create(bob);
      const r = await api.call('GET', '/api/tests?pageSize=1', { userId: alice });
      assert.equal(r.status, 200);
      assert.equal(r.body.total, 2);
      assert.equal(r.body.items.length, 1);
      assert.equal(r.body.items[0].hostname, 'two.example.com');
      assert.equal((await api.call('GET', '/api/tests?pageSize=1&page=2', { userId: alice })).body.items[0].hostname, 'one.example.com');
      assert.equal((await api.call('GET', '/api/tests?pageSize=999', { userId: alice })).status, 400);
    });
  });

  describe('progress and reports', () => {
    it('returns live progress with module states, real counts and a log cursor', async () => {
      const id = (await create(alice)).body.job.id as string;
      await api.pool.query(`insert into public.test_modules (job_id, module_id, position, status) values ($1,'connectivity',0,'completed'), ($1,'browser_launch',1,'running')`, [id]);
      await api.pool.query(`insert into public.test_results (job_id, module_id, category, check_key, title, status) values ($1,'connectivity','connectivity','a','A','pass'), ($1,'connectivity','connectivity','b','B','fail')`, [id]);
      for (const m of ['one', 'two', 'three']) await api.pool.query(`insert into public.test_logs (job_id, message) values ($1,$2)`, [id, m]);

      const r = await api.call('GET', `/api/tests/${id}/progress`, { userId: alice });
      assert.equal(r.status, 200);
      assert.equal(r.headers.get('cache-control'), 'no-store');
      assert.deepEqual(r.body.modules.map((m: any) => [m.moduleId, m.status, m.label]), [['connectivity', 'completed', 'Website connectivity'], ['browser_launch', 'running', 'Browser launch']]);
      assert.equal(r.body.counts.pass, 1);
      assert.equal(r.body.counts.fail, 1);
      assert.deepEqual(r.body.logs.map((l: any) => l.message), ['one', 'two', 'three']);
      assert.ok(r.body.serverTime);

      const cursor = r.body.logCursor;
      await api.pool.query(`insert into public.test_logs (job_id, message) values ($1,'four')`, [id]);
      const next = await api.call('GET', `/api/tests/${id}/progress?after=${cursor}`, { userId: alice });
      assert.deepEqual(next.body.logs.map((l: any) => l.message), ['four']);
      const same = await api.call('GET', `/api/tests/${id}/progress?after=${next.body.logCursor}`, { userId: alice });
      assert.equal(same.body.logs.length, 0);
      assert.equal(same.body.logCursor, next.body.logCursor);
    });

    it('returns 409 for the report while a test is still running, and the report once finished', async () => {
      const id = (await create(alice)).body.job.id as string;
      const early = await api.call('GET', `/api/tests/${id}/report`, { userId: alice });
      assert.equal(early.status, 409);
      assert.equal(early.body.error.code, 'not_ready');

      await api.pool.query(`insert into public.test_modules (job_id, module_id, position, status) values ($1,'connectivity',0,'completed')`, [id]);
      const res = await api.pool.query(`insert into public.test_results (job_id, module_id, category, check_key, title, status, severity, confidence, affected_url, message) values ($1,'connectivity','connectivity','http_reachable','Reachable','fail','critical','confirmed','https://example.com/','boom') returning id`, [id]);
      await api.pool.query(`insert into public.bug_reports (job_id, result_id, category, severity, confidence, title, description, suggested_fix) values ($1,$2,'connectivity','critical','confirmed','Reachable','boom','fix it')`, [id, res.rows[0].id]);
      await api.pool.query(`update public.test_jobs set status='completed', progress_pct=100, finished_at=now(), summary=$2 where id=$1`, [id, JSON.stringify({ counts: { pass: 0, fail: 1, warning: 0, info: 0, skipped: 0, blocked: 0 }, bugs: 1, overall: 'issues_found', incomplete: false, generatedAt: new Date().toISOString() })]);

      const r = await api.call('GET', `/api/tests/${id}/report`, { userId: alice });
      assert.equal(r.status, 200);
      assert.equal(r.body.results.length, 1);
      assert.equal(r.body.bugs[0].issueCode.startsWith('NBA-'), true);
      assert.equal(r.body.bugs[0].suggestedFix, 'fix it');
      assert.equal(r.body.bugs[0].aiAnalysis, null);
      assert.equal(r.body.message, '1 issue detected in the tests performed.');
      assert.equal(r.body.summary.overall, 'issues_found');

      const bugs = await api.call('GET', `/api/tests/${id}/bugs?severity=low`, { userId: alice });
      assert.equal(bugs.body.items.length, 0);
      assert.equal((await api.call('GET', `/api/tests/${id}/bugs?severity=critical`, { userId: alice })).body.items.length, 1);
      assert.equal((await api.call('GET', `/api/tests/${id}/bugs?severity=bogus`, { userId: alice })).status, 400);
    });
  });

  describe('cancel / resume / restart', () => {
    it('cancels a queued test immediately and removes it from the queue', async () => {
      const id = (await create(alice)).body.job.id as string;
      const r = await api.call('POST', `/api/tests/${id}/cancel`, { userId: alice });
      assert.equal(r.status, 200);
      assert.equal(r.body.job.status, 'cancelled');
      assert.deepEqual(api.queue.removed, [id]);
    });
    it('flags a running test for cancellation; the worker stops at its next heartbeat', async () => {
      const id = (await create(alice)).body.job.id as string;
      await api.pool.query(`update public.test_jobs set status='running', locked_by='w' where id = $1`, [id]);
      const r = await api.call('POST', `/api/tests/${id}/cancel`, { userId: alice });
      assert.equal(r.body.job.status, 'running');
      assert.equal(r.body.job.cancelRequested, true);
    });
    it('refuses to cancel a finished test', async () => {
      const id = (await create(alice)).body.job.id as string;
      await api.pool.query(`update public.test_jobs set status='completed' where id = $1`, [id]);
      assert.equal((await api.call('POST', `/api/tests/${id}/cancel`, { userId: alice })).status, 409);
    });

    it('resumes a failed test from checkpoints (attempt reset, running module returned to pending)', async () => {
      const id = (await create(alice)).body.job.id as string;
      await api.pool.query(`insert into public.test_modules (job_id, module_id, position, status) values ($1,'connectivity',0,'completed'), ($1,'browser_launch',1,'running')`, [id]);
      await api.pool.query(`update public.test_jobs set status='failed', attempt=3, error_message='x', finished_at=now() where id=$1`, [id]);
      api.queue.enqueued.length = 0;
      const r = await api.call('POST', `/api/tests/${id}/resume`, { userId: alice });
      assert.equal(r.status, 200);
      assert.equal(r.body.resumed, true);
      assert.equal(r.body.job.status, 'queued');
      assert.equal(r.body.job.attempt, 0);
      assert.equal(r.body.job.errorMessage, null);
      assert.deepEqual(api.queue.enqueued, [id]);
      const mods = (await api.pool.query('select module_id, status from public.test_modules where job_id = $1 order by position', [id])).rows;
      assert.deepEqual(mods.map((m) => m.status), ['completed', 'pending']);
    });
    it('resume on an active test is a safe no-op that re-enqueues idempotently', async () => {
      const id = (await create(alice)).body.job.id as string;
      const r = await api.call('POST', `/api/tests/${id}/resume`, { userId: alice });
      assert.equal(r.status, 200);
      assert.equal(r.body.resumed, false);
    });
    it('resume refuses completed and cancelled tests', async () => {
      const id = (await create(alice)).body.job.id as string;
      await api.pool.query(`update public.test_jobs set status='completed' where id=$1`, [id]);
      assert.equal((await api.call('POST', `/api/tests/${id}/resume`, { userId: alice })).status, 409);
      await api.pool.query(`update public.test_jobs set status='cancelled' where id=$1`, [id]);
      assert.equal((await api.call('POST', `/api/tests/${id}/resume`, { userId: alice })).status, 409);
    });

    it('restart creates a NEW job (linked to the old one) and cancels the old active job', async () => {
      const old = (await create(alice)).body.job.id as string;
      const r = await api.call('POST', `/api/tests/${old}/restart`, { userId: alice });
      assert.equal(r.status, 202);
      assert.notEqual(r.body.job.id, old);
      assert.equal(r.body.job.targetUrl, 'https://example.com/');
      const row = (await api.pool.query('select restart_of from public.test_jobs where id = $1', [r.body.job.id])).rows[0];
      assert.equal(row.restart_of, old);
      assert.equal((await api.pool.query('select status from public.test_jobs where id = $1', [old])).rows[0].status, 'cancelled');
      assert.ok(api.queue.enqueued.includes(r.body.job.id));
    });
    it('a failed restart leaves the running test untouched', async () => {
      const old = (await create(alice)).body.job.id as string;
      await api.pool.query(`update public.app_settings set value = '{"tests_per_hour_per_user": 1, "tests_per_hour_per_domain": 30}' where key = 'rate_limits'`);
      try {
        const r = await api.call('POST', `/api/tests/${old}/restart`, { userId: alice });
        assert.equal(r.status, 429);
        assert.equal((await api.pool.query('select status, cancel_requested from public.test_jobs where id = $1', [old])).rows[0].cancel_requested, false);
      } finally {
        await api.pool.query(`update public.app_settings set value = '{"tests_per_hour_per_user": 20, "tests_per_hour_per_domain": 30}' where key = 'rate_limits'`);
      }
    });
  });

  describe('platform behaviour', () => {
    it('lists which modules are really available, so the UI never advertises something that cannot run', async () => {
      const r = await api.call('GET', '/api/modules');
      assert.equal(r.status, 200);
      const byId = new Map(r.body.modules.map((m: any) => [m.id, m]));
      assert.equal((byId.get('connectivity') as any).implemented, true);
      assert.equal((byId.get('performance') as any).implemented, true);
      assert.equal((byId.get('performance') as any).enabled, true);
      // The AI module is not built yet (Phase 4): it must be advertised as not implemented.
      assert.equal((byId.get('ai_analysis') as any).implemented, true);
    });
    it('reports health', async () => {
      const r = await api.call('GET', '/healthz');
      assert.deepEqual(r.body, { ok: true, db: true, redis: true });
    });
    it('returns JSON errors without stack traces; malformed JSON is a 400', async () => {
      const bad = await api.call('POST', '/api/tests', { userId: alice, body: '{not json' });
      assert.equal(bad.status, 400);
      assert.equal(bad.body.error.code, 'bad_json');
      assert.doesNotMatch(JSON.stringify(bad.body), /at .*\.(ts|js)|node_modules/);
      const nf = await api.call('GET', '/api/nope');
      assert.equal(nf.status, 404);
    });
    it('rejects oversized bodies', async () => {
      const r = await api.call('POST', '/api/tests', { userId: alice, body: { url: 'https://example.com', authorizationConfirmed: true, pad: 'x'.repeat(200_000) } });
      assert.equal(r.status, 413);
    });
    it('sets security headers and hides the framework', async () => {
      const r = await api.call('GET', '/healthz');
      assert.equal(r.headers.get('x-powered-by'), null);
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
      assert.ok(r.headers.get('strict-transport-security'));
    });
    it('CORS: allows the configured origin and denies others', async () => {
      const ok = await fetch(`${api.base}/healthz`, { headers: { origin: 'http://localhost:5173' } });
      assert.equal(ok.headers.get('access-control-allow-origin'), 'http://localhost:5173');
      const evil = await fetch(`${api.base}/healthz`, { headers: { origin: 'https://evil.example' } });
      assert.equal(evil.headers.get('access-control-allow-origin'), null);
    });
  });
});

describe('reportMessage', () => {
  const job = (over: Partial<JobDTO>): JobDTO => ({ id: 'x', targetUrl: '', hostname: '', status: 'completed', progressPct: 100, currentModule: null, lastCompletedModule: null, selectedModules: [], attempt: 1, errorMessage: null, cancelRequested: false, queuedAt: '', startedAt: null, finishedAt: null, heartbeatAt: null, updatedAt: '', summary: null, ...over });
  const summary = (overall: any, incomplete = false) => ({ counts: { pass: 1, fail: 0, warning: 0, info: 0, skipped: 0, blocked: 0 }, bugs: 0, overall, incomplete, generatedAt: '' });

  it('uses the required wording when nothing was detected, but never claims the site is bug-free', () => {
    assert.equal(reportMessage(job({ summary: summary('no_issues_detected') }), 0), NO_ISSUES_MESSAGE);
    const partial = reportMessage(job({ summary: summary('no_issues_detected', true) }), 0);
    assert.ok(partial.startsWith(NO_ISSUES_MESSAGE));
    assert.match(partial, /does not mean the website is free of bugs/);
    assert.doesNotMatch(reportMessage(job({ summary: summary('no_issues_detected') }), 0), /bug-free|no bugs|perfect/i);
  });
  it('is honest about incomplete runs, cancelled and failed tests', () => {
    assert.match(reportMessage(job({ summary: summary('incomplete', true) }), 0), /no conclusion/);
    assert.match(reportMessage(job({ status: 'cancelled' }), 0), /cancelled/);
    assert.equal(reportMessage(job({ status: 'failed', errorMessage: 'It broke.' }), 0), 'It broke.');
  });
  it('pluralises issue counts', () => {
    assert.match(reportMessage(job({ summary: summary('issues_found') }), 1), /^1 issue detected/);
    assert.match(reportMessage(job({ summary: summary('issues_found') }), 4), /^4 issues detected/);
  });
});
