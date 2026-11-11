import type pg from 'pg';
import { type OtpPurpose, type SignupInput } from '@nba/shared';
import { EmailService, EmailSendError } from '../email/service.js';
import { accountExistsEmail, otpEmail, passwordChangedEmail } from '../email/templates.js';
import { forbidden, HttpError, tooMany, unauthorized } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import { type ClientContext, EmailExistsError, type IdentityProvider, type Session } from './identity.js';
import { type OtpService, type OtpVerifyResult } from './otp.js';
import { Throttle } from './throttle.js';
import type { SecurityMonitor } from '../services/security-monitor.js';

const HOUR = 3_600_000;
const QUARTER = 900_000;
/** Failed sign-ins (since the last success) before progressive delays begin. */
const FREE_FAILURES = 4;
const MAX_DELAY_SEC = 900;
const IP_FAILURE_LIMIT = 30;

export const GENERIC_SENT = 'If that email can be used, a 6-digit code is on its way.';
export const BAD_LOGIN = 'Incorrect email or password.';

interface Account {
  id: string;
  fullName: string;
  verified: boolean;
  status: 'active' | 'suspended';
}

export interface LoginSuccess {
  session: Session;
  user: { id: string; email: string; fullName: string; role: 'user' | 'admin' };
}

export interface AuthDeps {
  pool: pg.Pool;
  identity: IdentityProvider;
  otp: OtpService;
  email: EmailService;
  throttle: Throttle;
  logger: Logger;
  monitor?: SecurityMonitor;
}

const swallowRetry = (err: unknown): void => {
  if (err instanceof HttpError && err.status === 429) return;
  throw err;
};

export class AuthService {
  constructor(private readonly d: AuthDeps) {}

  // ---------------------------------------------------------------- helpers
  private async findAccount(email: string): Promise<Account | null> {
    const { rows } = await this.d.pool.query<{ id: string; full_name: string; email_verified_at: Date | null; account_status: 'active' | 'suspended' }>(
      'select id, full_name, email_verified_at, account_status from public.profiles where lower(email) = $1',
      [email],
    );
    const r = rows[0];
    return r ? { id: r.id, fullName: r.full_name, verified: r.email_verified_at !== null, status: r.account_status } : null;
  }

  private async sendOtp(email: string, name: string, purpose: OtpPurpose, ctx: ClientContext, userId?: string): Promise<void> {
    const { code } = await this.d.otp.issue(email, purpose, ctx.ip);
    const mail = otpEmail({ name: name || 'there', code, purpose, ttlMinutes: this.d.otp.ttlMinutes });
    try {
      await this.d.email.send(`otp_${purpose}`, { to: email, ...mail }, userId);
    } catch (err) {
      if (err instanceof EmailSendError) throw new HttpError(503, 'email_failed', "We couldn't send the email right now. Please try again in a moment.");
      throw err;
    }
  }

  private async audit(actorId: string | null, action: string, ip: string | null, metadata: Record<string, unknown> = {}): Promise<void> {
    await this.d.pool.query(`insert into public.audit_logs (actor_id, action, target_type, target_id, metadata, ip) values ($1::uuid,$2,'user',$1::uuid::text,$3::jsonb,$4)`, [
      actorId,
      action,
      JSON.stringify(metadata),
      ip,
    ]);
  }

  private async logLogin(userId: string | null, email: string, success: boolean, reason: string | null, ctx: ClientContext): Promise<void> {
    await this.d.pool.query(`insert into public.login_events (user_id, email, success, reason, ip, user_agent) values ($1,$2,$3,$4,$5,$6)`, [
      userId,
      email,
      success,
      reason,
      ctx.ip,
      ctx.userAgent?.slice(0, 300) ?? null,
    ]);
  }

  private otpFailure(r: Exclude<OtpVerifyResult, { ok: true }>): HttpError {
    switch (r.reason) {
      case 'invalid':
        return new HttpError(400, 'invalid_code', 'That code is incorrect.', { attemptsLeft: r.attemptsLeft });
      case 'expired':
        return new HttpError(400, 'code_expired', 'That code has expired. Please request a new one.');
      default:
        return new HttpError(400, 'code_locked', 'That code can no longer be used. Please request a new one.');
    }
  }

  // ---------------------------------------------------------------- signup & verification
  async signup(input: SignupInput, ctx: ClientContext): Promise<{ message: string; resendAfterSec: number; expiresInMinutes: number }> {
    const ip = ctx.ip ?? 'unknown';
    await this.d.throttle.hit('signup_ip', ip, 10, HOUR, 'Too many sign-up attempts from your network. Please try again later.');
    await this.d.throttle.hit('signup_email', input.email, 5, HOUR, 'Too many sign-up attempts for this email. Please try again later.');
    const done = { message: GENERIC_SENT, resendAfterSec: 60, expiresInMinutes: this.d.otp.ttlMinutes };

    const existing = await this.findAccount(input.email);
    if (existing?.verified) {
      // Do not reveal that the address is registered: same response, but tell the owner by email.
      await this.d.email.send('account_exists', { to: input.email, ...accountExistsEmail({ name: existing.fullName || 'there' }) }, existing.id).catch((e) => this.d.logger.warn({ err: String(e) }, 'account-exists email failed'));
      return done;
    }

    let userId: string;
    if (existing) {
      // An unverified account has never been proven to belong to anyone, so the latest sign-up replaces it.
      await this.d.identity.updatePendingUser(existing.id, { password: input.password, fullName: input.fullName, phone: input.phone });
      await this.d.pool.query('update public.profiles set full_name = $2, phone = $3 where id = $1', [existing.id, input.fullName, input.phone ?? null]);
      userId = existing.id;
    } else {
      try {
        userId = (await this.d.identity.createUser({ email: input.email, password: input.password, fullName: input.fullName, phone: input.phone })).id;
      } catch (err) {
        if (err instanceof EmailExistsError) return done; // lost a race with a concurrent sign-up
        throw err;
      }
    }
    await this.d.pool.query('update public.profiles set terms_accepted_at = now() where id = $1', [userId]);
    try {
      await this.sendOtp(input.email, input.fullName, 'signup', ctx, userId);
    } catch (err) {
      swallowRetry(err); // cooldown on an existing pending sign-up: stay silent (same response as a fresh one)
    }
    return done;
  }

  async verifySignupOtp(email: string, code: string, ctx: ClientContext): Promise<{ verified: true }> {
    await this.throttleVerify(email, ctx);
    const result = await this.d.otp.verify(email, 'signup', code);
    if (!result.ok) throw this.otpFailure(result);
    const account = await this.findAccount(email);
    if (!account) throw new HttpError(400, 'code_locked', 'That code can no longer be used. Please request a new one.');
    await this.d.identity.markEmailVerified(account.id);
    await this.d.pool.query('update public.profiles set email_verified_at = coalesce(email_verified_at, now()) where id = $1', [account.id]);
    await this.audit(account.id, 'account.email_verified', ctx.ip);
    return { verified: true };
  }

  async resendOtp(email: string, purpose: OtpPurpose, ctx: ClientContext): Promise<{ message: string; resendAfterSec: number }> {
    if (purpose === 'password_reset') {
      await this.forgotPassword(email, ctx);
      return { message: GENERIC_SENT, resendAfterSec: 60 };
    }
    await this.d.throttle.hit('resend_ip', ctx.ip ?? 'unknown', 20, HOUR, 'Too many requests. Please try again later.');
    const account = await this.findAccount(email);
    if (account && !account.verified) {
      try {
        await this.sendOtp(email, account.fullName, 'signup', ctx, account.id);
      } catch (err) {
        swallowRetry(err);
      }
    }
    return { message: GENERIC_SENT, resendAfterSec: 60 };
  }

  private async throttleVerify(email: string, ctx: ClientContext): Promise<void> {
    await this.d.throttle.hit('otp_ip', ctx.ip ?? 'unknown', 30, QUARTER, 'Too many attempts. Please wait a few minutes and try again.');
    await this.d.throttle.hit('otp_email', email, 15, QUARTER, 'Too many attempts. Please wait a few minutes and try again.');
  }

  // ---------------------------------------------------------------- login / sessions
  /** Failed sign-ins for this email since its last success (within 15 min), excluding rejected-while-throttled rows. */
  private async recentFailures(email: string): Promise<{ count: number; sinceLast: number }> {
    const { rows } = await this.d.pool.query<{ n: number; since: number | null }>(
      `select count(*)::int as n, extract(epoch from (now() - max(created_at)))::float8 as since
         from public.login_events
        where lower(email) = $1 and success = false and coalesce(reason, '') <> 'throttled'
          and created_at > now() - interval '15 minutes'
          and created_at > coalesce((select max(created_at) from public.login_events where lower(email) = $1 and success = true), '-infinity')`,
      [email],
    );
    return { count: rows[0]?.n ?? 0, sinceLast: rows[0]?.since ?? Infinity };
  }

  async login(email: string, password: string, ctx: ClientContext): Promise<LoginSuccess> {
    const account = await this.findAccount(email);
    const uid = account?.id ?? null;

    const ipFailures = ctx.ip
      ? (await this.d.pool.query<{ n: number }>(
          `select count(*)::int as n from public.login_events where ip = $1 and success = false and coalesce(reason,'') <> 'throttled' and created_at > now() - interval '15 minutes'`,
          [ctx.ip],
        )).rows[0]!.n
      : 0;
    const { count, sinceLast } = await this.recentFailures(email);

    // Progressive delay: after a few misses each further failure doubles the wait (5s, 10s, 20s ... 15 min).
    // Delays expire on their own, so a legitimate user is never locked out permanently.
    const wait = count > FREE_FAILURES ? Math.min(5 * 2 ** (count - FREE_FAILURES - 1), MAX_DELAY_SEC) : 0;
    const remaining = Math.ceil(wait - sinceLast);
    if (ipFailures >= IP_FAILURE_LIMIT || remaining > 0) {
      await this.logLogin(uid, email, false, 'throttled', ctx);
      throw Object.assign(tooMany('Too many unsuccessful attempts. Please wait before trying again.'), { retryAfterSec: Math.max(remaining, 30) });
    }

    const result = await this.d.identity.signIn(email, password, ctx);
    if (result.kind === 'bad_credentials') {
      await this.logLogin(uid, email, false, 'bad_password', ctx);
      await this.d.monitor?.onFailedLogin(email, uid, ctx);
      const failed = count + 1;
      throw new HttpError(401, 'invalid_credentials', BAD_LOGIN, { captchaRequired: failed >= 5 });
    }
    if (result.kind === 'unverified') {
      await this.logLogin(uid, email, false, 'unverified', ctx);
      throw new HttpError(403, 'email_not_verified', 'Please verify your email address before signing in.');
    }

    const profile = await this.d.pool.query<{ email: string; full_name: string; account_status: string; is_admin: boolean }>(
      `select p.email, p.full_name, p.account_status,
              exists (select 1 from public.user_roles r where r.user_id = p.id and r.role = 'admin') as is_admin
         from public.profiles p where p.id = $1`,
      [result.session.userId],
    );
    const p = profile.rows[0];
    if (!p) throw unauthorized(BAD_LOGIN);
    if (p.account_status !== 'active') {
      await this.d.identity.revoke(result.session.refreshToken).catch(() => undefined);
      await this.logLogin(result.session.userId, email, false, 'suspended', ctx);
      throw forbidden('This account has been suspended. Please contact support.');
    }
    await this.d.pool.query('update public.profiles set last_login_at = now() where id = $1', [result.session.userId]);
    await this.d.monitor?.onSuccessfulLogin(result.session.userId, email, ctx);
    await this.logLogin(result.session.userId, email, true, null, ctx);
    return { session: result.session, user: { id: result.session.userId, email: p.email, fullName: p.full_name, role: p.is_admin ? 'admin' : 'user' } };
  }

  async refresh(refreshToken: string, ctx: ClientContext): Promise<Session> {
    const session = await this.d.identity.refresh(refreshToken, ctx);
    if (!session) throw unauthorized('Your session has expired. Please sign in again.');
    const { rows } = await this.d.pool.query<{ account_status: string }>('select account_status from public.profiles where id = $1', [session.userId]);
    if (rows[0]?.account_status !== 'active') {
      await this.d.identity.revoke(session.refreshToken).catch(() => undefined);
      throw forbidden('This account has been suspended. Please contact support.');
    }
    return session;
  }

  async logout(refreshToken: string | null): Promise<void> {
    if (refreshToken) await this.d.identity.revoke(refreshToken).catch((e) => this.d.logger.warn({ err: String(e) }, 'logout revoke failed'));
  }

  // ---------------------------------------------------------------- password reset
  async forgotPassword(email: string, ctx: ClientContext): Promise<{ message: string; resendAfterSec: number }> {
    await this.d.throttle.hit('forgot_ip', ctx.ip ?? 'unknown', 10, HOUR, 'Too many requests. Please try again later.');
    await this.d.throttle.hit('forgot_email', email, 5, HOUR, 'Too many requests. Please try again later.');
    const account = await this.findAccount(email);
    if (account?.verified && account.status === 'active') {
      try {
        await this.sendOtp(email, account.fullName, 'password_reset', ctx, account.id);
      } catch (err) {
        swallowRetry(err);
      }
    }
    return { message: GENERIC_SENT, resendAfterSec: 60 };
  }

  async resetPassword(input: { email: string; code: string; newPassword: string }, ctx: ClientContext): Promise<{ reset: true }> {
    await this.throttleVerify(input.email, ctx);
    const result = await this.d.otp.verify(input.email, 'password_reset', input.code);
    if (!result.ok) throw this.otpFailure(result);
    const account = await this.findAccount(input.email);
    if (!account || !account.verified || account.status !== 'active') {
      throw new HttpError(400, 'code_locked', 'That code can no longer be used. Please request a new one.');
    }
    await this.d.identity.setPassword(account.id, input.newPassword);
    await this.d.identity.revokeAllSessions(account.id);
    await this.audit(account.id, 'password.reset', ctx.ip);
    await this.d.email.send('password_changed', { to: input.email, ...passwordChangedEmail({ name: account.fullName || 'there' }) }, account.id).catch((e) => this.d.logger.warn({ err: String(e) }, 'password-changed email failed'));
    return { reset: true };
  }
}
