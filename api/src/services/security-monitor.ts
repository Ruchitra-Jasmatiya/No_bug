import type pg from 'pg';
import { EmailService } from '../email/service.js';
import { securityAlertEmail } from '../email/templates.js';
import type { Logger } from '../lib/logger.js';

export interface LoginSecurityConfig {
  threshold: number;
  windowMinutes: number;
  captchaAfter: number;
}

const DEFAULTS: LoginSecurityConfig = { threshold: 10, windowMinutes: 15, captchaAfter: 5 };

export async function loadLoginSecurity(pool: pg.Pool): Promise<LoginSecurityConfig> {
  try {
    const { rows } = await pool.query<{ value: Record<string, number> }>(`select value from public.app_settings where key = 'login_security'`);
    const v = rows[0]?.value ?? {};
    return {
      threshold: Math.max(1, Number(v.failed_login_threshold) || DEFAULTS.threshold),
      windowMinutes: Math.max(1, Number(v.window_minutes) || DEFAULTS.windowMinutes),
      captchaAfter: Math.max(1, Number(v.captcha_after_failures) || DEFAULTS.captchaAfter),
    };
  } catch {
    return DEFAULTS;
  }
}

export interface LoginContext {
  ip: string | null;
  userAgent: string | null;
}

/**
 * Turns raw login events into security events and alerts.
 * - Alert fires only when failures EXCEED the threshold (so ">10" means the 11th failure) within the window.
 * - One alert per subject per window (unique dedupe_key), so an attack cannot flood the admin's inbox.
 * - The recipient comes only from ADMIN_NOTIFICATION_EMAIL; if unset the event is still recorded.
 */
export class SecurityMonitor {
  constructor(
    private readonly pool: pg.Pool,
    private readonly email: EmailService,
    private readonly adminEmail: string | undefined,
    private readonly logger: Logger,
  ) {}

  async onFailedLogin(email: string, userId: string | null, ctx: LoginContext): Promise<void> {
    try {
      const cfg = await loadLoginSecurity(this.pool);
      const win = `${cfg.windowMinutes} minutes`;
      const byEmail = await this.pool.query<{ n: number }>(
        `select count(*)::int as n from public.login_events
          where lower(email) = lower($1) and success = false and coalesce(reason,'') <> 'throttled' and created_at > now() - $2::interval`,
        [email, win],
      );
      const emailFails = byEmail.rows[0]?.n ?? 0;
      if (emailFails > cfg.threshold) {
        await this.raise({ kind: 'failed_logins_account', risk: emailFails > cfg.threshold * 2 ? 'critical' : 'high', subject: `acct:${email.toLowerCase()}`, email, userId, count: emailFails, ctx, cfg });
      }
      if (ctx.ip) {
        const byIp = await this.pool.query<{ n: number; emails: number }>(
          `select count(*)::int as n, count(distinct lower(email))::int as emails from public.login_events
            where ip = $1 and success = false and coalesce(reason,'') <> 'throttled' and created_at > now() - $2::interval`,
          [ctx.ip, win],
        );
        const ipFails = byIp.rows[0]?.n ?? 0;
        if (ipFails > cfg.threshold) {
          await this.raise({
            kind: byIp.rows[0]!.emails > 3 ? 'password_spraying' : 'failed_logins_ip',
            risk: byIp.rows[0]!.emails > 3 ? 'critical' : 'high',
            subject: `ip:${ctx.ip}`,
            email: null,
            userId: null,
            count: ipFails,
            ctx,
            cfg,
            details: { distinctAccounts: byIp.rows[0]!.emails },
          });
        }
      }
    } catch (err) {
      // Monitoring must never break sign-in.
      this.logger.error({ err: String(err) }, 'security monitor failed');
    }
  }

  /** Records informational events for successful sign-ins that deserve a second look. */
  async onSuccessfulLogin(userId: string, email: string, ctx: LoginContext): Promise<void> {
    try {
      const cfg = await loadLoginSecurity(this.pool);
      const recent = await this.pool.query<{ n: number }>(
        `select count(*)::int as n from public.login_events
          where lower(email) = lower($1) and success = false and coalesce(reason,'') <> 'throttled' and created_at > now() - $2::interval
            and created_at > coalesce((select max(created_at) from public.login_events where lower(email) = lower($1) and success = true and created_at < now() - interval '1 second'), '-infinity')`,
        [email, `${cfg.windowMinutes} minutes`],
      );
      const n = recent.rows[0]?.n ?? 0;
      if (n >= cfg.captchaAfter) {
        await this.record('success_after_failures', 'medium', userId, email, n, ctx, `saf:${userId}:${Math.floor(Date.now() / (cfg.windowMinutes * 60_000))}`, { failuresBefore: n });
      }
      if (ctx.ip) {
        const seen = await this.pool.query<{ n: number; any_success: number }>(
          `select count(*) filter (where ip = $2)::int as n, count(*)::int as any_success
             from public.login_events where user_id = $1 and success = true and created_at < now() - interval '1 second'`,
          [userId, ctx.ip],
        );
        const row = seen.rows[0];
        if (row && row.any_success > 0 && row.n === 0) {
          await this.record('new_ip_login', 'low', userId, email, null, ctx, `nip:${userId}:${ctx.ip}`, {});
        }
      }
    } catch (err) {
      this.logger.error({ err: String(err) }, 'security monitor (success) failed');
    }
  }

  private async record(kind: string, risk: string, userId: string | null, email: string | null, count: number | null, ctx: LoginContext, dedupeKey: string, details: Record<string, unknown>): Promise<string | null> {
    const r = await this.pool.query<{ id: string }>(
      `insert into public.security_events (kind, risk_level, user_id, email, attempt_count, ip, user_agent, details, dedupe_key)
       values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) on conflict (dedupe_key) where dedupe_key is not null do nothing returning id`,
      [kind, risk, userId, email, count, ctx.ip, ctx.userAgent?.slice(0, 300) ?? null, JSON.stringify(details), dedupeKey],
    );
    return r.rows[0]?.id ?? null;
  }

  private async raise(o: { kind: string; risk: string; subject: string; email: string | null; userId: string | null; count: number; ctx: LoginContext; cfg: LoginSecurityConfig; details?: Record<string, unknown> }): Promise<void> {
    const bucket = Math.floor(Date.now() / (o.cfg.windowMinutes * 60_000));
    const id = await this.record(o.kind, o.risk, o.userId, o.email, o.count, o.ctx, `${o.kind}:${o.subject}:${bucket}`, { windowMinutes: o.cfg.windowMinutes, threshold: o.cfg.threshold, ...o.details });
    if (!id) return; // already alerted for this subject in this window
    if (!this.adminEmail) {
      await this.pool.query(`update public.security_events set action_taken = 'recorded (ADMIN_NOTIFICATION_EMAIL not set; no email sent)' where id = $1`, [id]);
      this.logger.warn({ kind: o.kind }, 'security alert recorded but ADMIN_NOTIFICATION_EMAIL is not configured');
      return;
    }
    try {
      await this.email.send('security_alert', { to: this.adminEmail, ...securityAlertEmail({ kind: o.kind, risk: o.risk, email: o.email, ip: o.ctx.ip, userAgent: o.ctx.userAgent, count: o.count, windowMinutes: o.cfg.windowMinutes, at: new Date() }) });
      await this.pool.query(`update public.security_events set action_taken = 'admin emailed' where id = $1`, [id]);
    } catch {
      await this.pool.query(`update public.security_events set action_taken = 'recorded (alert email failed to send)' where id = $1`, [id]);
    }
  }
}
