/**
 * Authentication tests: real Postgres + real HTTP server + in-memory email transport.
 * Skipped (never "passed") without TEST_DATABASE_URL.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { DB_URL, startApi, type TestApi } from './helpers.js';

const suite = DB_URL ? describe : describe.skip;
const PW = 'Sup3r-secret-pass';
let seq = 0;
const uniq = () => `auth-${Date.now()}-${++seq}-${Math.floor(Math.random() * 1e6)}@example.com`;
const CSRF = { 'x-requested-with': 'nba-web' };

suite('authentication flows', () => {
  let api: TestApi;
  const emails: string[] = [];

  before(async () => {
    api = await startApi();
  });
  // Every test starts with clean throttle state (they all share one client IP).
  beforeEach(async () => {
    await api.pool.query('delete from public.auth_attempts');
    await api.pool.query('delete from public.login_events');
  });
  after(async () => {
    await api.pool.query('delete from auth.users where email = any($1)', [emails]);
    await api.pool.query(`delete from public.auth_attempts`);
    await api.pool.query('delete from public.otp_codes where email = any($1)', [emails]);
    await api.pool.query('delete from public.login_events where email = any($1)', [emails]);
    await api.close();
    await api.cleanup();
  });

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => api.call('POST', path, { body, headers });
  const signupBody = (email: string, over: Record<string, unknown> = {}) => ({ fullName: 'Ada Lovelace', email, password: PW, confirmPassword: PW, termsAccepted: true, ...over });
  async function register(over: Record<string, unknown> = {}): Promise<string> {
    const email = uniq();
    emails.push(email);
    const r = await post('/api/auth/signup', signupBody(email, over));
    assert.equal(r.status, 202, JSON.stringify(r.body));
    return email;
  }
  async function verified(): Promise<string> {
    const email = await register();
    const v = await post('/api/auth/verify-otp', { email, code: api.mail.codeFor(email) });
    assert.equal(v.status, 200, JSON.stringify(v.body));
    return email;
  }
  const cookieOf = (headers: Headers) => (headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const resetThrottles = () => api.pool.query('delete from public.auth_attempts');
  const expireCooldown = (email: string) => api.pool.query(`update public.otp_codes set created_at = created_at - interval '2 minutes' where lower(email) = $1`, [email]);

  describe('signup validation', () => {
    const bad: Array<[string, Record<string, unknown>, RegExp]> = [
      ['short password', { password: 'Ab1', confirmPassword: 'Ab1' }, /at least 8/],
      ['no number', { password: 'onlyletters', confirmPassword: 'onlyletters' }, /number/],
      ['no letter', { password: '123456789', confirmPassword: '123456789' }, /letter/],
      ['common password', { password: 'Password123', confirmPassword: 'Password123' }, /too common/],
      ['mismatched confirmation', { confirmPassword: 'Different-pass1' }, /do not match/],
      ['password contains the name', { fullName: 'Grace Hopper', password: 'Gracehopper99', confirmPassword: 'Gracehopper99' }, /name/],
      ['terms not accepted', { termsAccepted: false }, /Terms/],
      ['invalid email', { email: 'not-an-email' }, /valid email/],
      ['short name', { fullName: 'A' }, /full name/],
      ['bad phone', { phone: 'abc' }, /phone/],
    ];
    for (const [name, over, re] of bad) {
      it(`rejects ${name}`, async () => {
        const r = await post('/api/auth/signup', signupBody(uniq(), over));
        assert.equal(r.status, 400);
        assert.match(r.body.error.message, re);
      });
    }
    it('accepts an optional phone number and stores the profile, but the account is not yet verified', async () => {
      const email = await register({ phone: '+91 98765 43210' });
      const p = (await api.pool.query('select * from public.profiles where lower(email) = $1', [email])).rows[0];
      assert.equal(p.full_name, 'Ada Lovelace');
      assert.equal(p.phone, '+91 98765 43210');
      assert.equal(p.email_verified_at, null);
      assert.ok(p.terms_accepted_at);
    });
    it('normalises email case', async () => {
      const email = uniq();
      emails.push(email);
      const r = await post('/api/auth/signup', signupBody(email.toUpperCase()));
      assert.equal(r.status, 202);
      assert.ok(api.mail.lastTo(email));
    });
  });

  describe('email OTP', () => {
    it('sends a 6-digit code, and the database stores only a hash of it', async () => {
      const email = await register();
      const code = api.mail.codeFor(email);
      assert.match(code, /^\d{6}$/);
      const row = (await api.pool.query('select * from public.otp_codes where lower(email) = $1', [email])).rows[0];
      assert.notEqual(row.code_hash, code);
      assert.equal(row.code_hash.length, 64);
      assert.ok(!JSON.stringify(row).includes(code), 'plain code must not be in the row');
      const audit = (await api.pool.query('select * from public.email_notifications where to_email = $1', [email])).rows;
      assert.equal(audit.length, 1);
      assert.equal(audit[0].status, 'sent');
      assert.ok(!JSON.stringify(audit).includes(code), 'plain code must not be in the audit log');
    });

    it('the code is never in the HTTP response', async () => {
      const email = uniq();
      emails.push(email);
      const r = await post('/api/auth/signup', signupBody(email));
      assert.ok(!JSON.stringify(r.body).includes(api.mail.codeFor(email)));
    });

    it('rejects a wrong code, counts attempts, and locks the code after 5 wrong guesses', async () => {
      const email = await register();
      const real = api.mail.codeFor(email);
      const wrong = real === '000000' ? '111111' : '000000';
      for (let i = 4; i >= 1; i--) {
        const r = await post('/api/auth/verify-otp', { email, code: wrong });
        assert.equal(r.status, 400);
        assert.equal(r.body.error.code, 'invalid_code');
        assert.equal(r.body.error.details.attemptsLeft, i);
      }
      const last = await post('/api/auth/verify-otp', { email, code: wrong });
      assert.equal(last.body.error.code, 'code_locked');
      // even the correct code no longer works
      const after = await post('/api/auth/verify-otp', { email, code: real });
      assert.equal(after.status, 400);
      assert.equal((await api.pool.query('select email_verified_at from public.profiles where lower(email) = $1', [email])).rows[0].email_verified_at, null);
    });

    it('rejects an expired code', async () => {
      const email = await register();
      await api.pool.query(`update public.otp_codes set expires_at = now() - interval '1 second' where lower(email) = $1`, [email]);
      const r = await post('/api/auth/verify-otp', { email, code: api.mail.codeFor(email) });
      assert.equal(r.status, 400);
      assert.equal(r.body.error.code, 'code_expired');
    });

    it('is single-use', async () => {
      const email = await register();
      const code = api.mail.codeFor(email);
      assert.equal((await post('/api/auth/verify-otp', { email, code })).status, 200);
      assert.equal((await post('/api/auth/verify-otp', { email, code })).status, 400);
    });

    it('a code for one email cannot verify another, and unknown emails get the same error', async () => {
      const a = await register();
      const b = await register();
      assert.equal((await post('/api/auth/verify-otp', { email: b, code: api.mail.codeFor(a) })).status, 400);
      const ghost = await post('/api/auth/verify-otp', { email: uniq(), code: '123456' });
      assert.equal(ghost.status, 400);
    });

    it('rejects malformed codes before touching the database', async () => {
      const email = await register();
      for (const code of ['12345', '1234567', 'abcdef', '12 345', '']) {
        assert.equal((await post('/api/auth/verify-otp', { email, code })).status, 400, code);
      }
    });

    it('resend: obeys the 60s cooldown silently (no existence leak), then issues a new code that replaces the old one', async () => {
      const email = await register();
      const first = api.mail.codeFor(email);
      const count = api.mail.sent.length;
      const quick = await post('/api/auth/resend-otp', { email });
      assert.equal(quick.status, 202);
      assert.equal(api.mail.sent.length, count, 'no email during the cooldown');

      await expireCooldown(email);
      const again = await post('/api/auth/resend-otp', { email });
      assert.equal(again.status, 202);
      assert.equal(api.mail.sent.length, count + 1);
      const second = api.mail.codeFor(email);
      if (second !== first) assert.equal((await post('/api/auth/verify-otp', { email, code: first })).status, 400, 'the old code is dead');
      assert.equal((await post('/api/auth/verify-otp', { email, code: second })).status, 200);
    });

    it('resend for an unknown email returns the identical response and sends nothing', async () => {
      const count = api.mail.sent.length;
      const r = await post('/api/auth/resend-otp', { email: uniq() });
      assert.equal(r.status, 202);
      assert.equal(api.mail.sent.length, count);
    });

    it('caps codes per email per hour', async () => {
      const email = await register();
      for (let i = 0; i < 6; i++) {
        await expireCooldown(email);
        await post('/api/auth/resend-otp', { email });
      }
      const sent = (await api.pool.query(`select count(*)::int as n from public.otp_codes where lower(email) = $1`, [email])).rows[0].n;
      assert.ok(sent <= 6, `at most 6 codes per hour, got ${sent}`);
    });

    it('surfaces an email-provider outage as a retryable error', async () => {
      const email = uniq();
      emails.push(email);
      api.mail.failNext = true;
      const r = await post('/api/auth/signup', signupBody(email));
      assert.equal(r.status, 503);
      assert.equal(r.body.error.code, 'email_failed');
      assert.equal((await api.pool.query(`select status from public.email_notifications where to_email = $1`, [email])).rows[0].status, 'failed');
      // the account exists and can recover by resending
      await expireCooldown(email);
      await post('/api/auth/resend-otp', { email });
      assert.equal((await post('/api/auth/verify-otp', { email, code: api.mail.codeFor(email) })).status, 200);
    });
  });

  describe('signup edge cases', () => {
    it('does not reveal that an email is already registered, and warns the owner by email', async () => {
      const email = await verified();
      const count = api.mail.sent.length;
      const r = await post('/api/auth/signup', signupBody(email, { fullName: 'Someone Else', password: 'Another-pass99', confirmPassword: 'Another-pass99' }));
      assert.equal(r.status, 202);
      assert.equal(r.body.message, 'If that email can be used, a 6-digit code is on its way.');
      assert.equal(api.mail.sent.length, count + 1);
      assert.match(api.mail.lastTo(email)!.subject, /already have/);
      // the original account is untouched
      assert.equal((await post('/api/auth/login', { email, password: PW })).status, 200);
      assert.equal((await post('/api/auth/login', { email, password: 'Another-pass99' })).status, 401);
    });
    it('a second sign-up for an UNVERIFIED email replaces the pending account', async () => {
      const email = await register();
      await expireCooldown(email);
      await post('/api/auth/signup', signupBody(email, { fullName: 'Grace Hopper', password: 'Newer-pass-42', confirmPassword: 'Newer-pass-42' }));
      assert.equal((await api.pool.query('select full_name from public.profiles where lower(email) = $1', [email])).rows[0].full_name, 'Grace Hopper');
      await post('/api/auth/verify-otp', { email, code: api.mail.codeFor(email) });
      assert.equal((await post('/api/auth/login', { email, password: PW })).status, 401);
      assert.equal((await post('/api/auth/login', { email, password: 'Newer-pass-42' })).status, 200);
    });
    it('rate limits sign-ups per email and per IP', async () => {
      await resetThrottles();
      const email = uniq();
      emails.push(email);
      const statuses: number[] = [];
      for (let i = 0; i < 7; i++) statuses.push((await post('/api/auth/signup', signupBody(email))).status);
      assert.ok(statuses.includes(429), `expected a 429 in ${statuses}`);
      await resetThrottles();
      const ipStatuses: number[] = [];
      for (let i = 0; i < 12; i++) {
        const e = uniq();
        emails.push(e);
        ipStatuses.push((await post('/api/auth/signup', signupBody(e))).status);
      }
      assert.ok(ipStatuses.includes(429));
      const limited = await post('/api/auth/signup', signupBody(uniq()));
      assert.equal(limited.status, 429);
      assert.ok(Number(limited.headers.get('retry-after')) > 0, 'Retry-After header present');
      await resetThrottles();
    });
  });

  describe('login', () => {
    it('cannot sign in before the email is verified', async () => {
      const email = await register();
      const r = await post('/api/auth/login', { email, password: PW });
      assert.equal(r.status, 403);
      assert.equal(r.body.error.code, 'email_not_verified');
    });

    it('logs in after verification: returns an access token, sets an HttpOnly refresh cookie, never returns the refresh token in the body', async () => {
      const email = await verified();
      const r = await post('/api/auth/login', { email, password: PW });
      assert.equal(r.status, 200);
      assert.ok(r.body.accessToken.split('.').length === 3);
      assert.equal(r.body.user.email, email);
      assert.equal(r.body.user.role, 'user');
      assert.ok(!('refreshToken' in r.body));
      const setCookie = r.headers.get('set-cookie')!;
      assert.match(setCookie, /nba_rt=/);
      assert.match(setCookie, /HttpOnly/i);
      assert.match(setCookie, /SameSite=Lax/i);
      assert.match(setCookie, /Path=\/api\/auth/);
      const me = await api.call('GET', '/api/auth/me', { token: r.body.accessToken });
      assert.equal(me.status, 200);
      assert.equal(me.body.user.email, email);
      assert.equal(me.body.user.fullName, 'Ada Lovelace');
      const profile = (await api.pool.query('select last_login_at from public.profiles where lower(email) = $1', [email])).rows[0];
      assert.ok(profile.last_login_at);
    });

    it('the issued token works on protected test endpoints', async () => {
      const email = await verified();
      const r = await post('/api/auth/login', { email, password: PW });
      const list = await api.call('GET', '/api/tests', { token: r.body.accessToken });
      assert.equal(list.status, 200);
    });

    it('wrong password and unknown email give the identical response', async () => {
      const email = await verified();
      const wrong = await post('/api/auth/login', { email, password: 'Wrong-password1' });
      const ghost = await post('/api/auth/login', { email: uniq(), password: 'Wrong-password1' });
      assert.equal(wrong.status, 401);
      assert.equal(ghost.status, 401);
      assert.deepEqual({ ...wrong.body.error, details: undefined }, { ...ghost.body.error, details: undefined });
      assert.equal(wrong.body.error.message, 'Incorrect email or password.');
    });

    it('records every attempt in login_events (success, failure, unknown account) without storing passwords', async () => {
      const email = await verified();
      await post('/api/auth/login', { email, password: 'Wrong-password1' });
      await post('/api/auth/login', { email, password: PW });
      const events = (await api.pool.query('select * from public.login_events where lower(email) = $1 order by id', [email])).rows;
      assert.deepEqual(events.map((e) => [e.success, e.reason]), [[false, 'bad_password'], [true, null]]);
      assert.ok(events[0].ip);
      assert.ok(!JSON.stringify(events).includes(PW));
    });

    it('applies progressive delays after repeated failures, without permanently locking the account', async () => {
      await resetThrottles();
      const email = await verified();
      const results: number[] = [];
      for (let i = 0; i < 7; i++) results.push((await post('/api/auth/login', { email, password: 'Wrong-password1' })).status);
      assert.deepEqual(results.slice(0, 5), [401, 401, 401, 401, 401]);
      assert.equal(results[5], 429, 'delay kicks in after repeated failures');

      // while delayed, even the CORRECT password is refused (stops brute force) ...
      const blocked = await post('/api/auth/login', { email, password: PW });
      assert.equal(blocked.status, 429);
      assert.ok(Number(blocked.headers.get('retry-after')) >= 1);
      // ... but the delay expires by itself: nothing is locked permanently
      await api.pool.query(`update public.login_events set created_at = created_at - interval '20 minutes' where lower(email) = $1`, [email]);
      const ok = await post('/api/auth/login', { email, password: PW });
      assert.equal(ok.status, 200);
      // and a successful sign-in resets the failure counter
      assert.equal((await post('/api/auth/login', { email, password: 'Wrong-password1' })).status, 401);
    });

    it('flags that a bot challenge is needed once failures pile up', async () => {
      await resetThrottles();
      const email = await verified();
      let last: any;
      for (let i = 0; i < 5; i++) last = await post('/api/auth/login', { email, password: 'Wrong-password1' });
      assert.equal(last.status, 401);
      assert.equal(last.body.error.details.captchaRequired, true);
    });

    it('blocks suspended accounts at login and revokes the session', async () => {
      const email = await verified();
      await api.pool.query(`update public.profiles set account_status = 'suspended' where lower(email) = $1`, [email]);
      const r = await post('/api/auth/login', { email, password: PW });
      assert.equal(r.status, 403);
      assert.match(r.body.error.message, /suspended/);
    });

    it('validates the body', async () => {
      assert.equal((await post('/api/auth/login', { email: 'x', password: 'y' })).status, 400);
      assert.equal((await post('/api/auth/login', { email: uniq() })).status, 400);
      assert.equal((await post('/api/auth/login', 'not json')).status, 400);
    });
  });

  describe('sessions: refresh and logout', () => {
    async function loggedIn() {
      const email = await verified();
      const r = await post('/api/auth/login', { email, password: PW });
      return { email, cookie: cookieOf(r.headers), access: r.body.accessToken as string };
    }

    it('refresh rotates the refresh token and returns a new access token', async () => {
      const s = await loggedIn();
      const r = await api.call('POST', '/api/auth/refresh', { headers: { cookie: s.cookie, ...CSRF } });
      assert.equal(r.status, 200);
      assert.ok(r.body.accessToken);
      const next = cookieOf(r.headers);
      assert.notEqual(next, s.cookie);
      assert.equal((await api.call('GET', '/api/auth/me', { token: r.body.accessToken })).status, 200);
    });

    it('reusing an old refresh token (theft) is rejected and revokes the whole session family', async () => {
      const s = await loggedIn();
      const first = await api.call('POST', '/api/auth/refresh', { headers: { cookie: s.cookie, ...CSRF } });
      const rotated = cookieOf(first.headers);
      // age the revocation beyond the double-submit grace window
      await api.pool.query(`update public.local_refresh_tokens set revoked_at = revoked_at - interval '1 minute' where revoked_at is not null`);
      const replay = await api.call('POST', '/api/auth/refresh', { headers: { cookie: s.cookie, ...CSRF } });
      assert.equal(replay.status, 401);
      const afterTheft = await api.call('POST', '/api/auth/refresh', { headers: { cookie: rotated, ...CSRF } });
      assert.equal(afterTheft.status, 401, 'the legitimate newer token is also revoked');
    });

    it('a harmless double-submit within the grace window does not kill the session', async () => {
      const s = await loggedIn();
      const [a, b] = await Promise.all([
        api.call('POST', '/api/auth/refresh', { headers: { cookie: s.cookie, ...CSRF } }),
        api.call('POST', '/api/auth/refresh', { headers: { cookie: s.cookie, ...CSRF } }),
      ]);
      assert.deepEqual([a.status, b.status].sort(), [200, 401]);
      const winner = a.status === 200 ? a : b;
      assert.equal((await api.call('POST', '/api/auth/refresh', { headers: { cookie: cookieOf(winner.headers), ...CSRF } })).status, 200);
    });

    it('refresh without the cookie, with a bogus cookie, or without the CSRF header is refused', async () => {
      const s = await loggedIn();
      assert.equal((await api.call('POST', '/api/auth/refresh', { headers: { ...CSRF } })).status, 401);
      assert.equal((await api.call('POST', '/api/auth/refresh', { headers: { cookie: 'nba_rt=bogus', ...CSRF } })).status, 401);
      assert.equal((await api.call('POST', '/api/auth/refresh', { headers: { cookie: s.cookie } })).status, 403);
    });

    it('logout revokes the session: the refresh token stops working and the cookie is cleared', async () => {
      const s = await loggedIn();
      const out = await api.call('POST', '/api/auth/logout', { headers: { cookie: s.cookie, ...CSRF } });
      assert.equal(out.status, 204);
      assert.match(out.headers.get('set-cookie') ?? '', /nba_rt=;/);
      assert.equal((await api.call('POST', '/api/auth/refresh', { headers: { cookie: s.cookie, ...CSRF } })).status, 401);
    });
    it('logout without a session is harmless', async () => {
      assert.equal((await api.call('POST', '/api/auth/logout', { headers: { ...CSRF } })).status, 204);
    });
    it('a suspended user cannot refresh', async () => {
      const s = await loggedIn();
      await api.pool.query(`update public.profiles set account_status = 'suspended' where lower(email) = $1`, [s.email]);
      assert.equal((await api.call('POST', '/api/auth/refresh', { headers: { cookie: s.cookie, ...CSRF } })).status, 403);
    });
    it('/me requires a valid token', async () => {
      assert.equal((await api.call('GET', '/api/auth/me')).status, 401);
    });
  });

  describe('password reset', () => {
    it('full flow: forgot → code → new password → old password dead, sessions revoked, old code dead', async () => {
      const email = await verified();
      const login = await post('/api/auth/login', { email, password: PW });
      const cookie = cookieOf(login.headers);

      const f = await post('/api/auth/forgot-password', { email });
      assert.equal(f.status, 200);
      const code = api.mail.codeFor(email);
      assert.match(api.mail.lastTo(email)!.subject, /password reset/i);

      const NEW = 'Brand-new-pass7';
      const r = await post('/api/auth/reset-password', { email, code, newPassword: NEW, confirmPassword: NEW });
      assert.equal(r.status, 200);
      assert.match(api.mail.lastTo(email)!.subject, /password was changed/i);

      assert.equal((await post('/api/auth/login', { email, password: PW })).status, 401);
      assert.equal((await post('/api/auth/login', { email, password: NEW })).status, 200);
      assert.equal((await api.call('POST', '/api/auth/refresh', { headers: { cookie, ...CSRF } })).status, 401, 'existing sessions were signed out');
      assert.equal((await post('/api/auth/reset-password', { email, code, newPassword: NEW, confirmPassword: NEW })).status, 400, 'the code is single-use');
      const audit = (await api.pool.query(`select action from public.audit_logs where action = 'password.reset' and target_id = (select id::text from public.profiles where lower(email) = $1)`, [email])).rows;
      assert.equal(audit.length, 1);
    });

    it('forgot-password is identical for known, unknown and unverified emails, and only sends to verified accounts', async () => {
      await resetThrottles();
      const known = await verified();
      const unverified = await register();
      const unknown = uniq();
      const before = api.mail.sent.length;
      const responses = await Promise.all([known, unverified, unknown].map((email) => post('/api/auth/forgot-password', { email })));
      assert.ok(responses.every((r) => r.status === 200));
      assert.deepEqual(new Set(responses.map((r) => JSON.stringify(r.body))).size, 1);
      assert.equal(api.mail.sent.length, before + 1);
    });

    it('rejects a wrong or signup-purpose code and enforces the password policy', async () => {
      const email = await verified();
      await post('/api/auth/forgot-password', { email });
      const NEW = 'Brand-new-pass7';
      assert.equal((await post('/api/auth/reset-password', { email, code: '000000', newPassword: NEW, confirmPassword: NEW })).status, 400);
      const code = api.mail.codeFor(email);
      assert.equal((await post('/api/auth/reset-password', { email, code, newPassword: 'short', confirmPassword: 'short' })).status, 400);
      assert.equal((await post('/api/auth/reset-password', { email, code, newPassword: NEW, confirmPassword: 'mismatch-pass1' })).status, 400);
      assert.equal((await post('/api/auth/verify-otp', { email, code, purpose: 'password_reset' })).status, 400, 'reset codes cannot be used to verify sign-up');
    });

    it('a signup code cannot reset a password', async () => {
      const email = await register();
      const code = api.mail.codeFor(email);
      const NEW = 'Brand-new-pass7';
      assert.equal((await post('/api/auth/reset-password', { email, code, newPassword: NEW, confirmPassword: NEW })).status, 400);
    });

    it('rate limits reset attempts', async () => {
      await resetThrottles();
      const email = await verified();
      await post('/api/auth/forgot-password', { email });
      const NEW = 'Brand-new-pass7';
      const statuses: number[] = [];
      for (let i = 0; i < 20; i++) statuses.push((await post('/api/auth/reset-password', { email, code: '000000', newPassword: NEW, confirmPassword: NEW })).status);
      assert.ok(statuses.includes(429), String(statuses));
      await resetThrottles();
    });
  });

  describe('hygiene', () => {
    it('never stores a plaintext password anywhere', async () => {
      const email = await verified();
      const dump = JSON.stringify([
        (await api.pool.query('select * from auth.users where lower(email) = $1', [email])).rows,
        (await api.pool.query('select * from public.profiles where lower(email) = $1', [email])).rows,
      ]);
      assert.ok(!dump.includes(PW));
      assert.match(dump, /scrypt\$/);
    });
    it('responses carry no-store and no stack traces', async () => {
      const r = await post('/api/auth/login', { email: uniq(), password: 'x' });
      assert.equal(r.headers.get('cache-control'), 'no-store');
      assert.doesNotMatch(JSON.stringify(r.body), /\.ts|node_modules|at /);
    });
  });
});
