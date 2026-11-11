/**
 * End-to-end worker tests: real Postgres, real Chromium, a real (deliberately buggy) local website.
 *   TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:54329/nba_test npm test -w worker
 * Skipped (never reported as passed) when no database is configured.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Orchestrator } from '../src/orchestrator.js';
import { DB_URL, setupDb, silentLogger, startFixtureSite, testConfig, type TestDb } from './helpers.js';

const suite = DB_URL ? describe : describe.skip;
const policy = { allowPrivateTargets: true };

suite('orchestrator (end to end)', () => {
  let db: TestDb;
  let site: Awaited<ReturnType<typeof startFixtureSite>>;

  before(async () => {
    db = await setupDb();
    site = await startFixtureSite();
  });
  after(async () => {
    await site.close();
    await db.cleanup();
  });

  const makeOrchestrator = (workerId = 'test-worker-1', extra = {}) =>
    new Orchestrator({ store: db.store, config: testConfig({ workerId, ...extra }), logger: silentLogger, policy });

  const results = async (jobId: string) => (await db.pool.query(`select * from public.test_results where job_id = $1 order by module_id, check_key`, [jobId])).rows;
  const modules = async (jobId: string) => (await db.pool.query(`select * from public.test_modules where job_id = $1 order by position`, [jobId])).rows;
  const job = async (jobId: string) => (await db.pool.query(`select * from public.test_jobs where id = $1`, [jobId])).rows[0];

  it('runs the full flow and records REAL findings from a buggy site', async () => {
    const jobId = await db.createJob(`${site.base}/`);
    const outcome = await makeOrchestrator().runJob(jobId);
    assert.equal(outcome, 'completed');

    const j = await job(jobId);
    assert.equal(j.status, 'completed');
    assert.equal(j.progress_pct, 100);
    assert.ok(j.finished_at);
    assert.equal(j.locked_by, null);
    assert.equal(j.summary.overall, 'issues_found');

    const byKey = new Map((await results(jobId)).map((r) => [r.check_key as string, r]));
    assert.equal(byKey.get('dns_resolution')?.status, 'pass');
    assert.equal(byKey.get('http_reachable')?.status, 'pass');
    assert.equal(byKey.get('browser_launch')?.status, 'pass');
    assert.equal(byKey.get('page_load')?.status, 'pass');

    const all = await results(jobId);
    const find = (re: RegExp, status = 'fail') => all.find((r) => re.test(r.check_key) && r.status === status);
    assert.ok(find(/^exception_/), 'unhandled exception must be detected');
    assert.match(find(/^exception_/)!.message, /undefinedFunction/);
    assert.ok(find(/^console_error_/), 'console.error must be detected');
    assert.match(find(/^console_error_/)!.message, /Boom from inline script/);
    assert.ok(find(/^console_warnings$/, 'warning'), 'console warning must be detected');
    const http404 = all.filter((r) => /^http_error_404_/.test(r.check_key));
    const urls = http404.map((r) => r.affected_url).join(' ');
    assert.match(urls, /missing\.css/);
    assert.match(urls, /missing\.png/);
    assert.ok(http404.every((r) => r.status === 'fail' && r.confidence === 'confirmed' && r.evidence.status === 404));

    // bugs are stored with unique codes, raw evidence and a suggested fix; AI analysis is separate and still pending
    const bugs = (await db.pool.query(`select * from public.bug_reports where job_id = $1`, [jobId])).rows;
    assert.ok(bugs.length >= 5);
    assert.equal(new Set(bugs.map((b) => b.issue_code)).size, bugs.length);
    for (const b of bugs) {
      assert.match(b.issue_code, /^NBA-\d{6}$/);
      assert.ok(b.suggested_fix.length > 10);
      assert.equal(b.ai_analysis, null);
      assert.equal(b.ai_status, 'skipped'); // no AI provider configured in this test: honestly reported as skipped
      assert.ok(b.environment.testedAt);
    }
    assert.equal(j.summary.bugs, bugs.length);

    // every module settled; unimplemented ones are SKIPPED, never passed
    const mods = await modules(jobId);
    assert.ok(mods.every((m) => ['completed', 'skipped'].includes(m.status)));
    const ai = mods.find((m) => m.module_id === 'ai_analysis');
    assert.equal(ai.status, 'skipped');
    assert.match(ai.note, /not configured/i);
    assert.equal(all.filter((r) => r.module_id === 'ai_analysis').length, 0);

    const logs = (await db.pool.query(`select message from public.test_logs where job_id = $1 order by id`, [jobId])).rows.map((r) => r.message as string);
    assert.ok(logs.some((l) => /Test started/.test(l)));
    assert.ok(logs.some((l) => /Test finished/.test(l)));
  });

  it('a clean page produces passes, no false positives, and an unconfigured AI does not make the run incomplete', async () => {
    const jobId = await db.createJob(`${site.base}/clean`, ['console']); // only the Phase 1 modules: later modules legitimately report more on a plain-HTTP fixture
    assert.equal(await makeOrchestrator().runJob(jobId), 'completed');
    const j = await job(jobId);
    const all = await results(jobId);
    // The fixture is served over plain HTTP, so exactly one failure is correct and nothing else.
    assert.deepEqual(all.filter((r) => r.status === 'fail').map((r) => r.check_key), ['https_available']);
    assert.ok(all.some((r) => r.check_key === 'console_errors' && r.status === 'pass'));
    assert.ok(all.some((r) => r.check_key === 'unhandled_exceptions' && r.status === 'pass'));
    assert.ok(!all.some((r) => r.check_key === 'private_references'), "the site's own host is not a leaked dev URL");
    assert.equal(j.summary.incomplete, false, 'only the optional AI module was skipped; every selected test module ran');
  });

  it('detects a leaked localhost reference and the sandbox blocks it from the browser', async () => {
    const jobId = await db.createJob(`${site.base}/leaky`);
    await makeOrchestrator().runJob(jobId);
    const r = (await results(jobId)).find((x) => x.check_key === 'private_references');
    assert.ok(r, 'private reference must be reported');
    assert.equal(r.status, 'fail');
    assert.match(JSON.stringify(r.evidence), /127\.0\.0\.1:1\/dev-bundle\.js/);
  });

  it('reports a server error page as a failure', async () => {
    const jobId = await db.createJob(`${site.base}/error500`);
    await makeOrchestrator().runJob(jobId);
    const all = await results(jobId);
    const http = all.find((r) => r.check_key === 'http_reachable');
    assert.equal(http.status, 'fail');
    assert.equal(http.severity, 'critical');
    // target unusable → browser modules are BLOCKED, not passed
    const mods = await modules(jobId);
    assert.equal(mods.find((m) => m.module_id === 'page_inspection').status, 'blocked');
    assert.equal(all.filter((r) => r.module_id === 'page_inspection').length, 0);
  });

  it('handles an unreachable website: friendly failure, blocked modules, job still completes with a report', async () => {
    const jobId = await db.createJob('http://127.0.0.1:1/');
    assert.equal(await makeOrchestrator().runJob(jobId), 'completed');
    const j = await job(jobId);
    assert.equal(j.summary.overall, 'issues_found');
    const http = (await results(jobId)).find((r) => r.check_key === 'http_reachable');
    assert.equal(http.status, 'fail');
    assert.match(http.message, /could not reach this website/i);
    assert.doesNotMatch(JSON.stringify(http.message), /ECONN|stack|at .*\.ts/);
    const mods = await modules(jobId);
    assert.equal(mods.find((m) => m.module_id === 'browser_launch').status, 'blocked');
  });

  it('under the production network policy, loopback targets are blocked, never fetched', async () => {
    const strict = new Orchestrator({ store: db.store, config: testConfig(), logger: silentLogger, policy: { allowPrivateTargets: false } });
    const before = site.hits.get('/clean') ?? 0;
    const jobId = await db.createJob(`${site.base}/clean`);
    await strict.runJob(jobId);
    assert.equal(site.hits.get('/clean') ?? 0, before, 'the server must never receive a request');
    const r = (await results(jobId)).find((x) => x.module_id === 'connectivity' && x.status === 'blocked');
    assert.ok(r, 'connectivity must report the target as blocked');
  });

  describe('recovery', () => {
    it('is idempotent: redelivering a finished job does nothing and rewrites nothing', async () => {
      const jobId = await db.createJob(`${site.base}/clean`);
      assert.equal(await makeOrchestrator().runJob(jobId), 'completed');
      const before = await results(jobId);
      const hits = site.hits.get('/clean') ?? 0;
      assert.equal(await makeOrchestrator('other-worker').runJob(jobId), 'skipped_terminal');
      assert.deepEqual((await results(jobId)).map((r) => r.id), before.map((r) => r.id));
      assert.equal(site.hits.get('/clean') ?? 0, hits);
    });

    it('resumes from checkpoints after a crash and does NOT rerun completed modules', async () => {
      const jobId = await db.createJob(`${site.base}/clean`);
      // Simulate a worker that finished connectivity, then died mid-job (stale heartbeat).
      const first = await db.store.claimJob(jobId, 'dead-worker', 1500);
      assert.equal(first.kind, 'claimed');
      await db.store.ensureModules(first.kind === 'claimed' ? first.job : (undefined as never));
      await db.store.startModule(jobId, 'connectivity');
      await db.store.settleModule({ id: jobId }, 'connectivity', {
        status: 'completed',
        checkpoint: { reachable: true, marker: 'from-dead-worker' },
        outcomes: [{ checkKey: 'dns_resolution', title: 'DNS resolution', status: 'pass', message: 'saved by the dead worker' }],
      }, {}, 5);
      await db.store.startModule(jobId, 'browser_launch'); // died while this was running
      await db.pool.query(`update public.test_jobs set heartbeat_at = now() - interval '1 minute' where id = $1`, [jobId]);

      const connectivityHits = site.hits.get('/clean') ?? 0;
      assert.equal(await makeOrchestrator('rescuer').runJob(jobId), 'completed');

      const j = await job(jobId);
      assert.equal(j.status, 'completed');
      assert.equal(j.attempt, 2, 'second attempt');
      const conn = (await modules(jobId)).find((m) => m.module_id === 'connectivity');
      assert.equal(conn.attempt, 1, 'connectivity was not started again');
      assert.equal(conn.checkpoint.marker, 'from-dead-worker');
      const saved = (await results(jobId)).find((r) => r.check_key === 'dns_resolution');
      assert.equal(saved.message, 'saved by the dead worker', 'the saved result was kept, not recomputed');
      const bl = (await modules(jobId)).find((m) => m.module_id === 'browser_launch');
      assert.equal(bl.status, 'completed');
      assert.ok(connectivityHits >= 0);
      const logs = (await db.pool.query(`select message from public.test_logs where job_id = $1`, [jobId])).rows.map((r) => r.message as string);
      assert.ok(logs.some((l) => /Resuming test \(attempt 2\)/.test(l)));
      assert.ok(!logs.some((l) => /Website connectivity: started/.test(l)));
    });

    it('does not take over a job that a live worker is still heart-beating', async () => {
      const jobId = await db.createJob(`${site.base}/clean`);
      const claim = await db.store.claimJob(jobId, 'live-worker', 1500);
      assert.equal(claim.kind, 'claimed');
      assert.equal(await makeOrchestrator('intruder').runJob(jobId), 'skipped_held');
      assert.equal((await job(jobId)).locked_by, 'live-worker');
    });

    it('stops a worker that loses ownership instead of double-running', async () => {
      const jobId = await db.createJob(`${site.base}/slow`);
      const orch = makeOrchestrator('first');
      const run = orch.runJob(jobId);
      await new Promise((r) => setTimeout(r, 1500));
      await db.pool.query(`update public.test_jobs set locked_by = 'someone-else' where id = $1`, [jobId]);
      const outcome = await run;
      assert.equal(outcome, 'interrupted');
      assert.equal((await job(jobId)).status, 'running', 'the new owner keeps the job; the old worker did not finish it');
    });

    it('graceful shutdown hands the job back as resumable', async () => {
      const jobId = await db.createJob(`${site.base}/slow`);
      const orch = makeOrchestrator('shutting-down');
      const run = orch.runJob(jobId);
      await new Promise((r) => setTimeout(r, 1500));
      orch.requestShutdown();
      assert.equal(await run, 'interrupted');
      const j = await job(jobId);
      assert.equal(j.status, 'running');
      assert.equal(j.locked_by, null);
      assert.equal(j.attempt, 0);
      const claim = await db.store.claimJob(jobId, 'next-worker', 1500);
      assert.equal(claim.kind, 'claimed');
    });
  });

  describe('cancellation and limits', () => {
    it('stops promptly when cancellation is requested', async () => {
      const jobId = await db.createJob(`${site.base}/slow`);
      const run = makeOrchestrator('canceller').runJob(jobId);
      await new Promise((r) => setTimeout(r, 1200));
      await db.pool.query(`update public.test_jobs set cancel_requested = true where id = $1`, [jobId]);
      const t = Date.now();
      assert.equal(await run, 'cancelled');
      assert.ok(Date.now() - t < 5000, 'cancel must not wait for the slow page');
      const j = await job(jobId);
      assert.equal(j.status, 'cancelled');
      assert.ok(j.finished_at);
    });

    it('enforces the maximum job run time', async () => {
      await db.pool.query(`update public.app_settings set value = '{"job_ms": 1500, "module_ms": 120000, "navigation_ms": 30000}' where key = 'timeouts'`);
      try {
        const jobId = await db.createJob(`${site.base}/slow`);
        assert.equal(await makeOrchestrator('deadline').runJob(jobId), 'failed');
        const j = await job(jobId);
        assert.equal(j.status, 'failed');
        assert.match(j.error_message, /maximum run time/);
      } finally {
        await db.pool.query(`update public.app_settings set value = '{"job_ms": 600000, "module_ms": 120000, "navigation_ms": 30000}' where key = 'timeouts'`);
      }
    });

    it('marks a job failed after it exhausts its attempts', async () => {
      const jobId = await db.createJob(`${site.base}/clean`);
      await db.pool.query(`update public.test_jobs set attempt = max_attempts where id = $1`, [jobId]);
      assert.equal(await makeOrchestrator().runJob(jobId), 'failed');
      assert.equal((await job(jobId)).status, 'failed');
    });

    it('guards against a poison module that keeps crashing the worker', async () => {
      const jobId = await db.createJob(`${site.base}/clean`);
      const created = await db.store.claimJob(jobId, 'x', 1500);
      assert.equal(created.kind, 'claimed');
      await db.store.ensureModules(created.kind === 'claimed' ? created.job : (undefined as never));
      await db.pool.query(`update public.test_modules set attempt = 3 where job_id = $1 and module_id = 'connectivity'`, [jobId]);
      await db.pool.query(`update public.test_jobs set locked_by = null where id = $1`, [jobId]);
      await makeOrchestrator().runJob(jobId);
      const conn = (await modules(jobId)).find((m) => m.module_id === 'connectivity');
      assert.equal(conn.status, 'failed');
      assert.match(conn.error_message, /did not finish after 3 attempts/);
    });
  });

  it('progress is monotonic and reflects completed module weight, not a fake animation', async () => {
    const jobId = await db.createJob(`${site.base}/clean`);
    const seen: number[] = [];
    const poll = setInterval(() => void db.pool.query('select progress_pct from public.test_jobs where id = $1', [jobId]).then((r) => seen.push(r.rows[0].progress_pct)), 50);
    await makeOrchestrator().runJob(jobId);
    clearInterval(poll);
    for (let i = 1; i < seen.length; i++) assert.ok(seen[i]! >= seen[i - 1]!, `progress went backwards: ${seen.join(',')}`);
    assert.equal((await job(jobId)).progress_pct, 100);
    assert.ok(seen.some((p) => p > 0 && p < 100), 'intermediate progress must be observable');
  });
});
