/** The same page tested repeatedly must give the same findings. A drifting result (31 warnings, then 5, then 0) is a bug. */
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import type { ModuleId } from '@nba/shared';
import { Orchestrator } from '../src/orchestrator.js';
import { DB_URL, setupDb, silentLogger, testConfig, type TestDb } from './helpers.js';

const suite = DB_URL ? describe : describe.skip;
const MODULES: ModuleId[] = ['ui', 'seo', 'links_resources', 'site_pages', 'pagination', 'accessibility', 'responsive'];

const HOME = `<!doctype html><html><head><title>Shop</title></head><body>
<nav><a href="/about">About</a><a href="/gone">Gone</a></nav>
<main><h1>Shop</h1><img src="/missing.png"><button></button><input type="text">
<nav class="pagination"><a href="/?page=1">1</a><a href="/?page=2">2</a></nav></main></body></html>`;

suite('result consistency', () => {
  let db: TestDb;
  let server: http.Server;
  let base = '';
  before(async () => {
    db = await setupDb();
    server = http.createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://x');
      if (u.pathname === '/' ) return void res.writeHead(200, { 'content-type': 'text/html' }).end(HOME);
      if (u.pathname === '/about') return void res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>About</title><h1>About</h1>');
      res.writeHead(404, { 'content-type': 'text/html' }).end('<!doctype html><title>Not found</title>');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    await new Promise((r) => server.close(r));
    await db.cleanup();
  });

  async function once(): Promise<{ findings: string[]; statuses: string[] }> {
    const jobId = await db.createJob(`${base}/`, MODULES);
    await new Orchestrator({ store: db.store, config: testConfig(), logger: silentLogger, policy: { allowPrivateTargets: true } }).runJob(jobId);
    const rows = await db.pool.query<{ module_id: string; check_key: string; status: string }>(`select module_id, check_key, status from public.test_results where job_id=$1 order by module_id, check_key, status`, [jobId]);
    const mods = await db.pool.query<{ module_id: string; status: string }>(`select module_id, status from public.test_modules where job_id=$1 order by module_id`, [jobId]);
    return { findings: rows.rows.map((r) => `${r.module_id}:${r.check_key}:${r.status}`), statuses: mods.rows.map((m) => `${m.module_id}:${m.status}`) };
  }

  it('three runs of the same unchanged page produce identical findings and module outcomes', async () => {
    const a = await once();
    const b = await once();
    const c = await once();
    assert.ok(a.findings.some((f) => f.includes(':fail') || f.includes(':warning')), 'the fixture must actually have problems');
    assert.deepEqual(b.findings, a.findings);
    assert.deepEqual(c.findings, a.findings);
    assert.deepEqual(b.statuses, a.statuses);
    assert.ok(a.statuses.filter((s) => !s.startsWith('ai_analysis')).every((s) => s.endsWith(':completed')), `every module must finish: ${a.statuses.join(', ')}`);
  });
});
