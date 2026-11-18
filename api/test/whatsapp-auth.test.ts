/** Sign-up and login with a WhatsApp number: the code goes to WhatsApp (never the email), and a phone number can be used to sign in. */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { WhatsAppSendError, type WhatsAppSender } from '../src/whatsapp/sender.js';
import { DB_URL, startApi, type TestApi } from './helpers.js';

const suite = DB_URL ? describe : describe.skip;
const PW = 'Sup3r-secret-pass';

class FakeWhatsApp implements WhatsAppSender {
  readonly name = 'meta' as const;
  sent: { to: string; code: string }[] = [];
  fail = false;
  async sendOtp(to: string, code: string) {
    if (this.fail) throw new WhatsAppSendError('provider down');
    this.sent.push({ to, code });
    return { providerId: 'wamid.test' };
  }
  last(to: string): string {
    const m = [...this.sent].reverse().find((x) => x.to === to);
    assert.ok(m, `no WhatsApp message was sent to ${to}`);
    return m.code;
  }
}

suite('whatsapp authentication', () => {
  let api: TestApi;
  const wa = new FakeWhatsApp();
  const emails: string[] = [];
  const num = () => `+9197${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
  const mk = (over: Record<string, unknown> = {}) => {
    const email = `wa-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
    emails.push(email);
    return { email, body: { fullName: 'Asha Rao', email, phone: '+919800000001', whatsapp: num(), password: PW, confirmPassword: PW, termsAccepted: true, ...over } };
  };

  before(async () => {
    api = await startApi({ whatsapp: wa });
  });
  beforeEach(async () => {
    await api.pool.query('delete from public.auth_attempts');
    await api.pool.query('delete from public.login_events');
    wa.sent = [];
    wa.fail = false;
  });
  after(async () => {
    await api.pool.query('delete from auth.users where email = any($1)', [emails]);
    await api.pool.query('delete from public.otp_codes where email = any($1)', [emails]);
    await api.close();
    await api.cleanup();
  });

  it('requires both a contact number and a WhatsApp number', async () => {
    const a = mk();
    delete (a.body as Record<string, unknown>).whatsapp;
    const r1 = await api.call('POST', '/api/auth/signup', { body: a.body });
    assert.equal(r1.status, 400);
    const b = mk();
    delete (b.body as Record<string, unknown>).phone;
    const r2 = await api.call('POST', '/api/auth/signup', { body: b.body });
    assert.equal(r2.status, 400);
  });

  it('sends the code to the WhatsApp number and NOT to the email', async () => {
    const { email, body } = mk();
    const r = await api.call('POST', '/api/auth/signup', { body });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    assert.equal(wa.sent.length, 1);
    assert.equal(wa.sent[0]!.to, body.whatsapp);
    assert.match(wa.sent[0]!.code, /^\d{6}$/);
    assert.equal(api.mail.sent.filter((m) => m.to === email).length, 0, 'no email OTP may be sent');
    assert.ok(!JSON.stringify(r.body).includes(wa.sent[0]!.code), 'the code must never be in the HTTP response');
  });

  it('verifies with the WhatsApp code, then signs in with the email OR the phone number', async () => {
    const { email, body } = mk();
    await api.call('POST', '/api/auth/signup', { body });
    const v = await api.call('POST', '/api/auth/verify-otp', { body: { email, code: wa.last(body.whatsapp as string) } });
    assert.equal(v.status, 200, JSON.stringify(v.body));
    const byEmail = await api.call('POST', '/api/auth/login', { body: { email, password: PW } });
    assert.equal(byEmail.status, 200, JSON.stringify(byEmail.body));
    const byWa = await api.call('POST', '/api/auth/login', { body: { email: String(body.whatsapp).replace('+', '+ ').replace(/(\d{2})(\d{5})(\d{5})/, '$1 $2 $3'), password: PW } });
    assert.equal(byWa.status, 200, JSON.stringify(byWa.body));
    const byContact = await api.call('POST', '/api/auth/login', { body: { email: '+91 98000 00001', password: PW } });
    assert.equal(byContact.status, 200, JSON.stringify(byContact.body));
    const me = await api.call('GET', '/api/auth/me', { token: byWa.body.accessToken });
    assert.equal(me.body.user.whatsappNumber, body.whatsapp);
  });

  it('an unknown phone number fails exactly like a wrong password', async () => {
    const r = await api.call('POST', '/api/auth/login', { body: { email: '+919000000000', password: PW } });
    assert.equal(r.status, 401);
    assert.equal(r.body.error.code, 'invalid_credentials');
  });

  it('an unverified account is told to verify, and the response carries the email so the page can continue', async () => {
    const { email, body } = mk();
    await api.call('POST', '/api/auth/signup', { body });
    const r = await api.call('POST', '/api/auth/login', { body: { email: body.whatsapp, password: PW } });
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'email_not_verified');
    assert.equal(r.body.error.details?.email, email);
  });

  it('password reset sends its code to WhatsApp too', async () => {
    const { email, body } = mk();
    await api.call('POST', '/api/auth/signup', { body });
    await api.call('POST', '/api/auth/verify-otp', { body: { email, code: wa.last(body.whatsapp as string) } });
    await api.pool.query('delete from public.otp_codes where lower(email) = $1', [email]);
    wa.sent = [];
    const r = await api.call('POST', '/api/auth/forgot-password', { body: { email } });
    assert.equal(r.status, 200);
    assert.equal(wa.sent.length, 1);
    const reset = await api.call('POST', '/api/auth/reset-password', { body: { email, code: wa.sent[0]!.code, newPassword: 'N3w-secret-pass!', confirmPassword: 'N3w-secret-pass!' } });
    assert.equal(reset.status, 200, JSON.stringify(reset.body));
    const login = await api.call('POST', '/api/auth/login', { body: { email, password: 'N3w-secret-pass!' } });
    assert.equal(login.status, 200);
  });

  it('a WhatsApp provider outage is a clear, retryable error', async () => {
    wa.fail = true;
    const { body } = mk();
    const r = await api.call('POST', '/api/auth/signup', { body });
    assert.equal(r.status, 503);
    assert.equal(r.body.error.code, 'whatsapp_failed');
  });

  it('limits how many codes can be requested for one WhatsApp number', async () => {
    const number = num();
    let last = 0;
    for (let i = 0; i < 7; i++) {
      const { body } = mk({ whatsapp: number });
      last = (await api.call('POST', '/api/auth/signup', { body })).status;
    }
    assert.equal(last, 429);
  });
});
