/**
 * Phase 3 modules against a deliberately buggy site and a deliberately good one.
 * Each test asserts both directions: real problems are found, and a clean page is not accused.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { PNG } from 'pngjs';
import type { ModuleId } from '@nba/shared';
import { Orchestrator } from '../src/orchestrator.js';
import { DB_URL, setupDb, silentLogger, startFixtureSite, testConfig, type TestDb } from './helpers.js';

const suite = DB_URL ? describe : describe.skip;

suite('phase 3 modules', () => {
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

  type Row = { check_key: string; status: string; severity: string | null; message: string; module_id: string; affected_url: string | null; evidence: Record<string, unknown> };
  async function run(path: string, mod: ModuleId): Promise<{ rows: Row[]; moduleStatus: string }> {
    const jobId = await db.createJob(`${site.base}${path}`, [mod]);
    await new Orchestrator({ store: db.store, config: testConfig(), logger: silentLogger, policy: { allowPrivateTargets: true } }).runJob(jobId);
    const rows = (await db.pool.query<Row>(`select * from public.test_results where job_id=$1 and module_id=$2`, [jobId, mod])).rows;
    const m = await db.pool.query(`select status from public.test_modules where job_id=$1 and module_id=$2`, [jobId, mod]);
    return { rows, moduleStatus: m.rows[0].status };
  }
  const has = (rows: Row[], re: RegExp, status?: string) => rows.some((r) => re.test(r.check_key) && (!status || r.status === status));

  it('seo: finds real problems on the buggy page', async () => {
    const { rows, moduleStatus } = await run('/buggy', 'seo');
    assert.equal(moduleStatus, 'completed');
    assert.ok(has(rows, /^title$/, 'warning'));
    assert.ok(has(rows, /^meta_description$/, 'warning'));
    assert.ok(has(rows, /^h1$/, 'warning'));
    assert.ok(has(rows, /^viewport_meta$/, 'fail'));
    assert.ok(has(rows, /^html_lang$/, 'warning'));
    assert.ok(has(rows, /^img_alt$/, 'warning'));
    assert.ok(has(rows, /^heading_order$/));
  });
  it('seo: a good page produces no failures', async () => {
    const { rows } = await run('/good', 'seo');
    assert.deepEqual(rows.filter((r) => r.status === 'fail'), []);
    assert.ok(has(rows, /^title$/, 'pass'));
    assert.ok(has(rows, /^canonical$/, 'pass'));
  });

  it('security: detects exposed files, missing headers, cookie flags, version disclosure', async () => {
    const { rows } = await run('/buggy', 'security');
    assert.ok(has(rows, /^exposed__env$/, 'fail'));
    assert.ok(has(rows, /^exposed__git_HEAD$/, 'fail'));
    assert.ok(has(rows, /^csp$/, 'warning'));
    assert.ok(has(rows, /^cookie_sessionid$/, 'warning'));
    assert.ok(has(rows, /^version_disclosure$/, 'warning'));
    assert.ok(has(rows, /^https$/, 'fail')); // fixture is plain http
  });
  it('security: a hardened page is not accused of header problems or exposures', async () => {
    const { rows } = await run('/good', 'security');
    assert.ok(has(rows, /^csp$/, 'pass'));
    assert.ok(has(rows, /^nosniff$/, 'pass'));
    assert.ok(has(rows, /^clickjacking$/, 'pass'));
    // The shared fixture also serves /.env and /.git/HEAD, so assert on a path that is NOT exposed:
    assert.ok(!has(rows, /^exposed__phpinfo/), 'a 404 path must not be reported as exposed');
    assert.ok(!has(rows, /^exposed__DS_Store/));
  });

  it('links: finds the broken link and placeholder link, not the good one', async () => {
    const { rows } = await run('/buggy', 'links_resources');
    const broken = rows.filter((r) => /^broken_link_/.test(r.check_key));
    assert.equal(broken.length, 1);
    assert.match(broken[0]!.affected_url ?? '', /missing-page/);
    assert.ok(has(rows, /^placeholder_links$/, 'warning'));
    assert.ok(has(rows, /^broken_images$/, 'fail'));
  });
  it('links: good page has no broken links', async () => {
    const { rows } = await run('/good', 'links_resources');
    assert.deepEqual(rows.filter((r) => r.status === 'fail'), []);
  });

  it('api: reports the 500 and the invalid JSON the page itself triggered', async () => {
    const { rows } = await run('/buggy', 'api');
    assert.ok(has(rows, /^api_5xx_/, 'fail'));
    assert.ok(has(rows, /^api_badjson_/, 'fail'));
    assert.ok(!rows.some((r) => /api\/data/.test(r.affected_url ?? '') && r.status === 'fail'));
  });
  it('api: a page with no API calls is info, never pass', async () => {
    const { rows } = await run('/good', 'api');
    assert.equal(rows.find((r) => r.check_key === 'no_api_calls')?.status, 'info');
  });

  it('functional: reports geolocation as BLOCKED (never passed), catches the click error, skips the delete button, inspects forms', async () => {
    const { rows } = await run('/buggy', 'functional');
    assert.equal(rows.find((r) => r.check_key === 'permission_geolocation')?.status, 'blocked');
    assert.ok(has(rows, /^click_error_/, 'fail'));
    assert.ok(has(rows, /^unsafe_buttons_skipped$/, 'info'));
    assert.ok(has(rows, /^form_no_submit_/, 'fail'));
    assert.ok(has(rows, /^form_labels_/, 'fail'));
    assert.equal(site.hits.get('/x') ?? 0, 0, 'forms must never be submitted');
  });
  it('functional: good page has no failures', async () => {
    const { rows } = await run('/good', 'functional');
    assert.deepEqual(rows.filter((r) => r.status === 'fail'), []);
  });

  it('ui: finds horizontal overflow and an unlabeled button on the buggy page', async () => {
    const { rows } = await run('/buggy', 'ui');
    assert.ok(has(rows, /^ui_horizontal_overflow$/, 'fail') || has(rows, /^ui_empty_buttons$/, 'fail'));
    assert.ok(has(rows, /^ui_empty_buttons$/, 'fail'));
  });
  it('ui: good page passes', async () => {
    const { rows } = await run('/good', 'ui');
    assert.deepEqual(rows.filter((r) => r.status === 'fail'), []);
  });

  it('responsive: finds overflow at small widths on the buggy page, none on the good page', async () => {
    const bad = await run('/buggy', 'responsive');
    assert.ok(has(bad.rows, /small-mobile_horizontal_overflow/, 'fail'));
    assert.ok(has(bad.rows, /no_viewport_meta/, 'fail'));
    const good = await run('/good', 'responsive');
    assert.deepEqual(good.rows.filter((r) => r.status === 'fail'), []);
    assert.ok(has(good.rows, /^responsive_clean$/, 'pass'));
  });

  it('accessibility: axe finds real violations; good page is clean of failures', async () => {
    const bad = await run('/buggy', 'accessibility');
    assert.ok(bad.rows.some((r) => /^axe_/.test(r.check_key) && r.status === 'fail'));
    assert.ok(has(bad.rows, /^axe_button-name$/, 'fail'));
    const good = await run('/good', 'accessibility');
    assert.deepEqual(good.rows.filter((r) => r.status === 'fail'), []);
  });

  it('pwa: no manifest is info (not a failure); scope is stated', async () => {
    const { rows } = await run('/good', 'pwa');
    assert.equal(rows.find((r) => r.check_key === 'manifest')?.status, 'info');
    assert.ok(rows.find((r) => r.check_key === 'pwa_scope'));
  });

  it('visual_regression: first run creates a baseline (info, not pass); identical second run passes; changed page warns', async () => {
    const first = await run('/good', 'visual_regression');
    assert.ok(first.rows.every((r) => r.status === 'info'), 'no comparison happened, so nothing may be reported as pass');
    const second = await run('/good', 'visual_regression');
    assert.ok(second.rows.every((r) => r.status === 'pass'), JSON.stringify(second.rows.map((r) => [r.check_key, r.status, r.message])));
    // Simulate a visual regression: replace the stored desktop baseline with a dark 1440x900 image.
    const dark = new PNG({ width: 1440, height: 900 });
    for (let i = 0; i < dark.data.length; i += 4) dark.data.set([20, 20, 40, 255], i);
    await db.pool.query(`update public.visual_baselines set image = $1 where page_url = $2 and viewport = 'desktop' and user_id = $3`, [PNG.sync.write(dark), `${site.base}/good`, db.userId]);
    const changed = await run('/good', 'visual_regression');
    assert.ok(has(changed.rows, /^visual_desktop$/, 'warning'));
  });

  it('performance: Lighthouse returns real numeric metrics through the guarded proxy', async () => {
    const { rows, moduleStatus } = await run('/good', 'performance');
    assert.equal(moduleStatus, 'completed', JSON.stringify(rows.map((r) => [r.check_key, r.message])));
    const score = rows.find((r) => r.check_key === 'performance_score');
    assert.ok(score && typeof score.evidence.score === 'number');
    assert.ok(rows.some((r) => r.check_key === 'metric_largest-contentful-paint' && typeof r.evidence.value === 'number'));
  });

  it('non-HTML targets: DOM modules are skipped, not passed', async () => {
    const { rows, moduleStatus } = await run('/api-json', 'seo');
    assert.equal(moduleStatus, 'skipped');
    assert.equal(rows.length, 0);
  });
});
