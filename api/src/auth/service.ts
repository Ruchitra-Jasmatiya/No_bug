import type pg from 'pg';
import { normalizePhone, type OtpPurpose, type SignupInput } from '@nba/shared';
import { EmailService, EmailSendError } from '../email/service.js';
import { accountExistsEmail, otpEmail, passwordChangedEmail } from '../email/templates.js';
import { forbidden, HttpError, tooMany, unauthorized } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import { type ClientContext, EmailExistsError, type IdentityProvider, type Session } from './identity.js';
import { type OtpService, type OtpVerifyResult } from './otp.js';
import { type WhatsAppSender, WhatsAppSendError } from '../whatsapp/sender.js';
import { Throttle } from './throttle.js';
import type { SecurityMonitor } from '../services/security-monitor.js';

const HOUR = 3_600_000;
const QUARTER = 900_000;
const IP_FAILURE_LIMIT = 30;

export const GENERIC_SENT = 'If that account can be used, a 6-digit code is on its way to its WhatsApp number.';
export const BAD_LOGIN = 'Incorrect email, phone number or password.';

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
  /** One-time codes go here when the account has a WhatsApp number; email is only the fallback for accounts without one. */
  whatsapp?: WhatsAppSender;
  throttle: Throttle;
  logger: Logger;
  monitor?: SecurityMonitor;
  /** Wrong passwords allowed per window per account (default 5), then locked until the window is clear (default 60 s). */
  loginMaxAttempts?: number;
  loginWindowSec?: number;
}

const swallowRetry = (err: unknown): void => {
  if (err instanceof HttpError && err.status === 429) return;
  throw err;
};

export class AuthService {
  private readonly maxAttempts: number;
  private readonly windowSec: number;
  constructor(private readonly d: AuthDeps) {
    this.maxAttempts = d.loginMaxAttempts ?? 5;
    this.windowSec = d.loginWindowSec ?? 60;
  }

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
    const wa = this.d.whatsapp && this.d.whatsapp.name !== 'none' ? this.d.whatsapp : null;
    if (wa) {
      const { rows } = await this.d.pool.query<{ whatsapp_number: string | null }>('select whatsapp_number from public.profiles where lower(email) = $1', [email]);
      const to = rows[0]?.whatsapp_number;
      if (to) {
        try {
          const { providerId } = await wa.sendOtp(to, code, this.d.otp.ttlMinutes);
          await this.audit(userId ?? null, `otp.whatsapp.${purpose}`, ctx.ip, { provider: wa.name, providerId });
          return;
        } catch (err) {
          this.d.logger.error({ provider: wa.name, reason: err instanceof Error ? err.message : 'unknown' }, 'whatsapp delivery failed');
          if (err instanceof WhatsAppSendError) throw new HttpError(503, 'whatsapp_failed', "We couldn't send the WhatsApp message right now. Please check the number and try again in a moment.");
          throw err;
        }
      }
    }
    const mail = otpEmail({ name: name || 'there', code, purpose, ttlMinutes: this.d.otp.ttlMinutes });
    try {
      await this.d.email.send(`otp_${purpose}`, { to: email, ...mail }, userId);
    } catch (err) {
      if (err instanceof EmailSendError) throw new HttpError(503, 'email_failed', "We couldn't send the code right now. Please try again in a moment.");
      throw err;
    }
  }

  /** Accepts an email or a phone / WhatsApp number and returns the account email it belongs to (null when unknown). */
  private async resolveIdentifier(identifier: string): Promise<string | null> {
    if (identifier.includes('@')) return identifier.toLowerCase();
    const phone = normalizePhone(identifier);
    if (!phone) return null;
    const { rows } = await this.d.pool.query<{ email: string }>(
      `select email from public.profiles where (whatsapp_number = $1 or phone = $1) and account_status = 'active'
        order by (email_verified_at is not null) desc, created_at asc limit 1`,
      [phone],
    );
    return rows[0]?.email.toLowerCase() ?? null;
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
    await this.d.throttle.hit('signup_whatsapp', input.whatsapp, 5, HOUR, 'Too many codes have been requested for this WhatsApp number. Please try again later.');
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
      await this.d.pool.query('update public.profiles set full_name = $2, phone = $3, whatsapp_number = $4 where id = $1', [existing.id, input.fullName, input.phone, input.whatsapp]);
      userId = existing.id;
    } else {
      try {
        userId = (await this.d.identity.createUser({ email: input.email, password: input.password, fullName: input.fullName, phone: input.phone })).id;
      } catch (err) {
        if (err instanceof EmailExistsError) return done; // lost a race with a concurrent sign-up
        throw err;
      }
    }
    await this.d.pool.query('update public.profiles set terms_accepted_at = now(), phone = $2, whatsapp_number = $3 where id = $1', [userId, input.phone, input.whatsapp]);
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
  /** Failed sign-ins for this email inside the window and since its last success, excluding rejected-while-locked rows. */
  private async recentFailures(email: string): Promise<{ count: number; sinceLast: number }> {
    const { rows } = await this.d.pool.query<{ n: number; since: number | null }>(
      `select count(*)::int as n, extract(epoch from (now() - max(created_at)))::float8 as since
         from public.login_events
        where lower(email) = $1 and success = false and coalesce(reason, '') <> 'throttled'
          and created_at > now() - make_interval(secs => $2::int)
          and created_at > coalesce((select max(created_at) from public.login_events where lower(email) = $1 and success = true), '-infinity')`,
      [email, this.windowSec],
    );
    return { count: rows[0]?.n ?? 0, sinceLast: rows[0]?.since ?? Infinity };
  }

  async login(identifier: string, password: string, ctx: ClientContext): Promise<LoginSuccess> {
    const resolved = await this.resolveIdentifier(identifier);
    // An unknown phone number gets the same generic failure as a wrong password (and cannot be used to probe accounts).
    const email = resolved ?? (identifier.includes('@') ? identifier.toLowerCase() : `${identifier.replace(/\D/g, '') || 'unknown'}@phone.invalid`);
    const account = await this.findAccount(email);
    const uid = account?.id ?? null;

    const ipFailures = ctx.ip
      ? (await this.d.pool.query<{ n: number }>(
          `select count(*)::int as n from public.login_events where ip = $1 and success = false and coalesce(reason,'') <> 'throttled' and created_at > now() - interval '15 minutes'`,
          [ctx.ip],
        )).rows[0]!.n
      : 0;
    const { count, sinceLast } = await this.recentFailures(email);

    // Fixed window: after `maxAttempts` wrong passwords the account is locked until the window has been quiet for
    // `windowSec` seconds (default 5 wrong tries, then 1 minute). The lock expires on its own; nothing is locked forever.
    const remaining = count >= this.maxAttempts ? Math.ceil(this.windowSec - sinceLast) : 0;
    if (ipFailures >= IP_FAILURE_LIMIT || remaining > 0) {
      await this.logLogin(uid, email, false, 'throttled', ctx);
      const wait = Math.max(remaining, 5);
      throw Object.assign(new HttpError(429, 'rate_limited', `Too many wrong attempts. Please wait ${wait} seconds before trying again.`, { attemptsLeft: 0, lockedForSec: wait }), { retryAfterSec: wait });
    }

    const result = await this.d.identity.signIn(email, password, ctx);
    if (result.kind === 'bad_credentials') {
      await this.logLogin(uid, email, false, 'bad_password', ctx);
      await this.d.monitor?.onFailedLogin(email, uid, ctx);
      const left = Math.max(0, this.maxAttempts - (count + 1));
      if (left === 0) {
        throw Object.assign(new HttpError(429, 'rate_limited', `${BAD_LOGIN} No attempts left. Please wait ${this.windowSec} seconds before trying again.`, { attemptsLeft: 0, lockedForSec: this.windowSec }), { retryAfterSec: this.windowSec });
      }
      throw new HttpError(401, 'invalid_credentials', BAD_LOGIN, { attemptsLeft: left, maxAttempts: this.maxAttempts });
    }
    if (result.kind === 'unverified') {
      await this.logLogin(uid, email, false, 'unverified', ctx);
      throw new HttpError(403, 'email_not_verified', 'Please verify your WhatsApp number before signing in.', { email });
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
