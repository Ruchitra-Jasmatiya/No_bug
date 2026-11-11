/** Admin API + security monitoring: real Postgres, real HTTP, in-memory email. */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { DB_URL, startApi, type TestApi } from './helpers.js';

const suite = DB_URL ? describe : describe.skip;
const ALERT_TO = 'alerts-' + 'inbox@example.org';
const PW = 'Sup3r-secret-pass';
const CSRF = { 'x-requested-with': 'nba-web' };
let seq = 0;

suite('admin API', () => {
  let api: TestApi;
  before(async () => {
    api = await startApi({ config: { ADMIN_NOTIFICATION_EMAIL: ALERT_TO } });
  });
  after(async () => {
    await api.close();
    await api.cleanup();
  });

  it('rejects anonymous and non-admin users on every admin route', async () => {
    const user = await api.makeUser();
    const paths = ['overview', 'analytics', 'system', 'users', 'tests', 'security/events', 'security/logins', 'audit-logs', 'emails', 'settings'];
    for (const p of paths) {
      assert.equal((await api.call('GET', `/api/admin/${p}`)).status, 401, p);
      assert.equal((await api.call('GET', `/api/admin/${p}`, { userId: user })).status, 403, p);
    }
    assert.equal((await api.call('PUT', '/api/admin/settings/ai', { userId: user, body: { value: {} } })).status, 403);
  });

  it('a forged admin claim in the token does not grant access', async () => {
    const user = await api.makeUser();
    const { SignJWT } = await import('jose');
    const { JWT_SECRET } = await import('./helpers.js');
    const tk = await new SignJWT({ role: 'authenticated', app_metadata: { role: 'admin' }, user_role: 'admin' }).setProtectedHeader({ alg: 'HS256' }).setSubject(user).setAudience('authenticated').setExpirationTime('1h').sign(new TextEncoder().encode(JWT_SECRET));
    assert.equal((await api.call('GET', '/api/admin/overview', { token: tk })).status, 403);
  });

  it('overview, analytics and system return real numbers', async () => {
    const admin = await api.makeUser({ admin: true });
    const o = await api.call('GET', '/api/admin/overview', { userId: admin });
    assert.equal(o.status, 200);
    assert.ok(o.body.users.total >= 1);
    const before = o.body.tests.total;
    await api.pool.query(`insert into public.test_projects (user_id, name, base_url, hostname) values ($1,'a.test','https://a.test/','a.test')`, [admin]);
    await api.pool.query(`insert into public.test_jobs (project_id, user_id, target_url, hostname, status, selected_modules) select id,$1,'https://a.test/','a.test','completed',array['console'] from public.test_projects where user_id=$1`, [admin]);
    assert.equal((await api.call('GET', '/api/admin/overview', { userId: admin })).body.tests.total, before + 1);
    const an = await api.call('GET', '/api/admin/analytics?days=7', { userId: admin });
    assert.equal(an.body.testsPerDay.length, 7);
    assert.ok(an.body.testsPerDay.at(-1).total >= 1);
    const sys = await api.call('GET', '/api/admin/system', { userId: admin });
    assert.equal(sys.body.database, true);
    assert.equal(sys.body.ai.configured, false);
    assert.equal(sys.body.adminAlertEmailConfigured, true);
  });

  it('suspends and reactivates users, blocks them immediately, audits, and protects the admin themself', async () => {
    const admin = await api.makeUser({ admin: true });
    const victim = await api.makeUser();
    assert.equal((await api.call('GET', '/api/tests', { userId: victim })).status, 200);
    const s = await api.call('PATCH', `/api/admin/users/${victim}/status`, { userId: admin, body: { status: 'suspended', reason: 'abuse' } });
    assert.equal(s.status, 200);
    assert.equal((await api.call('GET', '/api/tests', { userId: victim })).status, 403);
    assert.equal((await api.call('PATCH', `/api/admin/users/${admin}/status`, { userId: admin, body: { status: 'suspended' } })).status, 400);
    await api.call('PATCH', `/api/admin/users/${victim}/status`, { userId: admin, body: { status: 'active' } });
    assert.equal((await api.call('GET', '/api/tests', { userId: victim })).status, 200);
    const log = await api.call('GET', '/api/admin/audit-logs?pageSize=50', { userId: admin });
    const actions = log.body.items.filter((i: any) => i.targetId === victim).map((i: any) => i.action);
    assert.ok(actions.includes('user.suspended') && actions.includes('user.reactivated'));
  });

  it('role changes: promote, demote, and never remove the last admin or yourself', async () => {
    const admin = await api.makeUser({ admin: true });
    const other = await api.makeUser();
    assert.equal((await api.call('PATCH', `/api/admin/users/${other}/role`, { userId: admin, body: { role: 'admin' } })).status, 200);
    assert.equal((await api.call('GET', '/api/admin/overview', { userId: other })).status, 200);
    assert.equal((await api.call('PATCH', `/api/admin/users/${admin}/role`, { userId: admin, body: { role: 'user' } })).status, 400);
    assert.equal((await api.call('PATCH', `/api/admin/users/${other}/role`, { userId: admin, body: { role: 'user' } })).status, 200);
    assert.equal((await api.call('GET', '/api/admin/overview', { userId: other })).status, 403);
    assert.equal((await api.call('PATCH', `/api/admin/users/${other}/role`, { userId: admin, body: { role: 'wizard' } })).status, 400);
    assert.equal((await api.call('PATCH', '/api/admin/users/not-a-uuid/role', { userId: admin, body: { role: 'user' } })).status, 404);
  });

  it('lists users with search, filters and pagination (no secrets exposed)', async () => {
    const admin = await api.makeUser({ admin: true });
    const r = await api.call('GET', '/api/admin/users?pageSize=2&page=1', { userId: admin });
    assert.equal(r.status, 200);
    assert.ok(r.body.items.length <= 2);
    assert.ok(r.body.total >= 1);
    assert.ok(!JSON.stringify(r.body).match(/password|hash|token/i));
    const s = await api.call('GET', '/api/admin/users?search=%25', { userId: admin }); // wildcard is escaped
    assert.equal(s.body.items.length, 0);
  });

  describe('settings', () => {
    it('reads and updates validated settings and audits the change', async () => {
      const admin = await api.makeUser({ admin: true });
      const get = await api.call('GET', '/api/admin/settings', { userId: admin });
      assert.ok(get.body.items.find((i: any) => i.key === 'login_security'));
      const put = await api.call('PUT', '/api/admin/settings/rate_limits', { userId: admin, body: { value: { tests_per_hour_per_user: 7, tests_per_hour_per_domain: 9 } } });
      assert.equal(put.status, 200);
      assert.equal((await api.pool.query(`select value from public.app_settings where key='rate_limits'`)).rows[0].value.tests_per_hour_per_user, 7);
      await api.pool.query(`update public.app_settings set value='{"tests_per_hour_per_user": 20, "tests_per_hour_per_domain": 30}'::jsonb where key='rate_limits'`);
      const log = await api.call('GET', '/api/admin/audit-logs', { userId: admin });
      assert.ok(log.body.items.some((i: any) => i.action === 'setting.updated' && i.targetId === 'rate_limits'));
    });
    it('rejects unknown keys, out-of-range values, extra fields and secrets', async () => {
      const admin = await api.makeUser({ admin: true });
      const put = (k: string, v: unknown) => api.call('PUT', `/api/admin/settings/${k}`, { userId: admin, body: { value: v } });
      assert.equal((await put('nope', {})).status, 404);
      assert.equal((await put('rate_limits', { tests_per_hour_per_user: 0, tests_per_hour_per_domain: 9 })).status, 400);
      assert.equal((await put('ai', { provider: 'anthropic', model_env: 'AI_MODEL', max_findings_per_job: 5, api_key: 'sk-ant-leak' })).status, 400);
      assert.equal((await put('enabled_modules', ['connectivity', 'rm_rf'])).status, 400);
      assert.equal((await put('login_security', { failed_login_threshold: 'ten', window_minutes: 15, captcha_after_failures: 5 })).status, 400);
    });
  });

  describe('failed-login security monitoring', () => {
    beforeEach(async () => {
      await api.pool.query('delete from public.auth_attempts');
      await api.pool.query('delete from public.login_events');
      await api.pool.query('delete from public.security_events');
      api.mail.sent.length = 0;
    });
    const uniq = () => `sec-${Date.now()}-${++seq}@example.com`;
    async function account(): Promise<string> {
      const email = uniq();
      await api.call('POST', '/api/auth/signup', { body: { fullName: 'Sec Test', email, password: PW, confirmPassword: PW, termsAccepted: true } });
      await api.call('POST', '/api/auth/verify-otp', { body: { email, code: api.mail.codeFor(email) } });
      api.mail.sent.length = 0;
      return email;
    }
    const fail = (email: string) => api.call('POST', '/api/auth/login', { body: { email, password: 'wrong-Pass-123' }, headers: CSRF });
    /** Inserts n failed-login rows as if they had happened, then triggers one real failure. */
    async function seedFailures(email: string, n: number) {
      await api.pool.query(`insert into public.login_events (email, success, reason, ip, created_at) select $1, false, 'bad_password', '203.0.113.9', now() - interval '10 minutes' from generate_series(1,$2)`, [email, n]);
    }
    const alerts = () => api.mail.sent.filter((m) => m.to === ALERT_TO);

    it('does NOT alert at exactly 10 failures, DOES alert at 11 (more than 10)', async () => {
      const email = await account();
      await seedFailures(email, 9);
      await fail(email); // 10th
      assert.equal(alerts().length, 0);
      assert.equal((await api.pool.query(`select count(*)::int n from public.security_events where kind='failed_logins_account'`)).rows[0].n, 0);
    });

    it('alerts the configured admin address once the threshold is exceeded, with useful detail and no password', async () => {
      const email = await account();
      await seedFailures(email, 10);
      await fail(email); // 11th
      const sent = alerts();
      assert.equal(sent.length, 1);
      assert.match(sent[0]!.subject, /Security/);
      assert.ok(sent[0]!.text.includes(email));
      assert.match(sent[0]!.text, /Failed attempts: 11 within 15 minutes/);
      assert.ok(!sent[0]!.text.includes('wrong-Pass-123'));
      const ev = (await api.pool.query(`select * from public.security_events where kind='failed_logins_account'`)).rows;
      assert.equal(ev.length, 1);
      assert.equal(ev[0].action_taken, 'admin emailed');
      assert.equal(ev[0].attempt_count, 11);
    });

    it('does not flood: further failures in the same window do not send more alerts', async () => {
      const email = await account();
      await seedFailures(email, 10);
      await fail(email);
      await fail(email);
      await fail(email);
      assert.equal(alerts().length, 1);
      assert.equal((await api.pool.query(`select count(*)::int n from public.security_events where kind='failed_logins_account'`)).rows[0].n, 1);
    });

    it('flags password spraying: one address, many accounts', async () => {
      const emails = await Promise.all([account(), account(), account(), account()]);
      for (const e of emails) await seedFailures(e, 3);
      // seed rows use 203.0.113.9, so seed the real client ip too: discover it from one real failure
      await fail(emails[0]!);
      const ip = (await api.pool.query(`select ip from public.login_events where success=false order by id desc limit 1`)).rows[0].ip;
      await api.pool.query(`insert into public.login_events (email, success, reason, ip) select 'x'||g||'@example.com', false, 'bad_password', $1 from generate_series(1,12) g`, [ip]);
      await fail(emails[1]!);
      const kinds = (await api.pool.query(`select kind from public.security_events`)).rows.map((r) => r.kind);
      assert.ok(kinds.includes('password_spraying'), kinds.join(','));
    });

    it('still records the event when ADMIN_NOTIFICATION_EMAIL is not set (and sends nothing)', async () => {
      const bare = await startApi({});
      try {
        const email = uniq();
        await bare.call('POST', '/api/auth/signup', { body: { fullName: 'Sec Test', email, password: PW, confirmPassword: PW, termsAccepted: true } });
        await bare.call('POST', '/api/auth/verify-otp', { body: { email, code: bare.mail.codeFor(email) } });
        bare.mail.sent.length = 0;
        await bare.pool.query(`insert into public.login_events (email, success, reason, ip, created_at) select $1, false, 'bad_password', '203.0.113.9', now() - interval '10 minutes' from generate_series(1,10)`, [email]);
        await bare.call('POST', '/api/auth/login', { body: { email, password: 'wrong-Pass-123' }, headers: CSRF });
        assert.equal(bare.mail.sent.length, 0);
        const ev = (await bare.pool.query(`select action_taken from public.security_events where kind='failed_logins_account'`)).rows;
        assert.equal(ev.length, 1);
        assert.match(ev[0].action_taken, /not set/);
      } finally {
        await bare.close();
        await bare.pool.end();
      }
    });

    it('records success-after-failures; admins can list, filter and acknowledge events (audited)', async () => {
      const admin = await api.makeUser({ admin: true });
      const email = await account();
      await seedFailures(email, 6);
      const ok = await api.call('POST', '/api/auth/login', { body: { email, password: PW }, headers: CSRF });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      const list = await api.call('GET', '/api/admin/security/events?acknowledged=false', { userId: admin });
      const saf = list.body.items.find((e: any) => e.kind === 'success_after_failures');
      assert.ok(saf, 'success after failures recorded');
      assert.equal((await api.call('POST', `/api/admin/security/events/${saf.id}/acknowledge`, { userId: admin })).status, 200);
      const after = await api.call('GET', '/api/admin/security/events?acknowledged=true', { userId: admin });
      assert.ok(after.body.items.some((e: any) => e.id === saf.id && e.acknowledged));
      assert.equal((await api.call('POST', '/api/admin/security/events/00000000-0000-0000-0000-000000000000/acknowledge', { userId: admin })).status, 404);
      const logins = await api.call('GET', '/api/admin/security/logins?success=true', { userId: admin });
      assert.ok(logins.body.items.every((l: any) => l.success === true));
    });

    it('the admin email address is never hardcoded in the source tree', async () => {
      const { execSync } = await import('node:child_process');
      const needle = 'ruchit' + 'rajasmatiya';
      const out = execSync(`grep -rIl --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git "${needle}" ../.. || true`, { cwd: import.meta.dirname }).toString();
      assert.equal(out.trim(), '');
    });
  });
});
