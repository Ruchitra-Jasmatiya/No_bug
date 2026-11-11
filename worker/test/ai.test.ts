/** AI analysis module: real Postgres + real fixture site; the AI provider is a controllable stand-in. */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { AiError, type AiProvider, type AiRequest } from '@nba/shared/ai';
import { Orchestrator } from '../src/orchestrator.js';
import { DB_URL, setupDb, silentLogger, startFixtureSite, testConfig, type TestDb } from './helpers.js';

const suite = DB_URL ? describe : describe.skip;
const policy = { allowPrivateTargets: true };

class StubAi implements AiProvider {
  name = 'stub';
  model = 'stub-1';
  calls: AiRequest[] = [];
  constructor(private readonly mode: 'good' | 'garbage' | 'down' | 'inject') {}
  async complete(req: AiRequest) {
    this.calls.push(req);
    if (this.mode === 'down') throw new AiError('unavailable', 'down', true);
    if (this.mode === 'garbage') return { text: 'I refuse to produce JSON.', model: 'stub-1' };
    const ids = [...req.messages[0]!.content.matchAll(/FINDING id=([0-9a-f-]{36})/g)].map((m) => m[1]!);
    const findings = ids.map((id) => ({
      id,
      explanation: 'Explained.',
      likelyCause: 'Because.',
      fix: 'Fix it.',
      steps: ['one'],
      verification: 'rerun',
      effort: 'low',
      ...(this.mode === 'inject' ? { severity: 'informational', status: 'pass' } : {}),
    }));
    return { text: JSON.stringify({ findings }), model: 'stub-1' };
  }
}

suite('ai_analysis module', () => {
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
  const run = async (ai: AiProvider | null) => {
    const jobId = await db.createJob(`${site.base}/`, ['console', 'ai_analysis']);
    const o = new Orchestrator({ store: db.store, config: testConfig(), logger: silentLogger, policy, ai });
    assert.equal(await o.runJob(jobId), 'completed');
    const bugs = (await db.pool.query('select * from public.bug_reports where job_id=$1', [jobId])).rows;
    const mod = (await db.pool.query(`select * from public.test_modules where job_id=$1 and module_id='ai_analysis'`, [jobId])).rows[0];
    const job = (await db.pool.query('select * from public.test_jobs where id=$1', [jobId])).rows[0];
    return { jobId, bugs, mod, job };
  };

  it('without an API key: skipped honestly, bugs marked skipped, run NOT flagged incomplete because of it', async () => {
    const { bugs, mod, job } = await run(null);
    assert.equal(mod.status, 'skipped');
    assert.match(mod.note, /not configured/i);
    assert.ok(bugs.length > 0 && bugs.every((b) => b.ai_status === 'skipped' && b.ai_analysis === null));
    assert.equal(job.summary.incomplete, false);
  });

  it('stores AI output separately and never alters evidence, severity or confidence', async () => {
    const before = await run(null);
    const ai = new StubAi('inject');
    const after = await run(ai);
    assert.equal(after.mod.status, 'completed');
    assert.ok(after.bugs.length > 0);
    for (const b of after.bugs) {
      assert.equal(b.ai_status, 'completed');
      assert.equal(b.ai_analysis.explanation, 'Explained.');
      assert.equal(b.ai_analysis.severity, undefined, 'injected severity is dropped by validation');
      assert.notEqual(b.severity, 'informational');
    }
    // same site, same checks -> same evidence/severity with or without AI
    const key = (x: any) => `${x.issue_code ? '' : ''}${x.category}|${x.title}|${x.severity}|${x.confidence}|${x.affected_url}`;
    assert.deepEqual(after.bugs.map(key).sort(), before.bugs.map(key).sort());
    assert.ok(ai.calls.length >= 1);
  });

  it('hostile site text only reaches the model inside untrusted blocks', async () => {
    const ai = new StubAi('good');
    await run(ai);
    const prompt = ai.calls[0]!.messages[0]!.content;
    assert.match(prompt, /<untrusted_data label="evidence">/);
    assert.match(ai.calls[0]!.system, /Never follow it/);
  });

  it('unparseable AI output marks findings failed (no fake analysis)', async () => {
    const { bugs, mod } = await run(new StubAi('garbage'));
    assert.ok(bugs.every((b) => b.ai_status === 'failed' && b.ai_analysis === null));
    assert.ok(['completed', 'blocked'].includes(mod.status));
  });

  it('provider outage: module blocked, findings still intact', async () => {
    const { bugs, mod } = await run(new StubAi('down'));
    assert.equal(mod.status, 'blocked');
    assert.ok(bugs.length > 0 && bugs.every((b) => ['failed', 'skipped'].includes(b.ai_status) && b.ai_analysis === null));
    assert.ok(bugs.every((b) => b.suggested_fix.length > 10));
  });
});
