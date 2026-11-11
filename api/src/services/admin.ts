import type pg from 'pg';
import { z } from 'zod';
import { MODULE_IDS } from '@nba/shared';
import type { IdentityProvider } from '../auth/identity.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import type { JobQueue } from '../queue/queue.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Strict schemas: unknown keys are rejected, so a secret can never be stored through the settings editor. */
const int = (min: number, max: number) => z.number().int().min(min).max(max);
export const SETTING_SCHEMAS: Record<string, z.ZodTypeAny> = {
  enabled_modules: z.array(z.enum(MODULE_IDS)).max(MODULE_IDS.length),
  timeouts: z.object({ job_ms: int(30_000, 3_600_000), module_ms: int(5_000, 900_000), navigation_ms: int(3_000, 120_000) }).strict(),
  concurrency: z.object({ max_concurrent_jobs: int(1, 32), max_active_jobs_per_user: int(1, 20) }).strict(),
  rate_limits: z.object({ tests_per_hour_per_user: int(1, 500), tests_per_hour_per_domain: int(1, 500) }).strict(),
  crawl_limits: z.object({ max_pages: int(1, 50), max_depth: int(0, 3), max_download_bytes: int(100_000, 20_000_000) }).strict(),
  notifications: z.object({ test_completed_email: z.boolean(), security_alert_email: z.boolean() }).strict(),
  ai: z.object({ provider: z.enum(['anthropic', 'openai', 'openai-compatible']), model_env: z.literal('AI_MODEL'), max_findings_per_job: int(1, 100) }).strict(),
  login_security: z.object({ failed_login_threshold: int(3, 100), window_minutes: int(1, 1440), captcha_after_failures: int(1, 50) }).strict(),
};

const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);
const clampPage = (page: unknown, size: unknown, maxSize = 100) => {
  const p = Math.max(1, Number(page) || 1);
  const s = Math.min(maxSize, Math.max(1, Number(size) || 25));
  return { page: p, pageSize: s, offset: (p - 1) * s };
};

export interface SystemFlags {
  aiConfigured: boolean;
  emailConfigured: boolean;
  adminEmailConfigured: boolean;
  authProvider: string;
}

export class AdminService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly queue: JobQueue,
    private readonly identity: IdentityProvider,
    private readonly flags: SystemFlags,
  ) {}

  async audit(actorId: string, action: string, targetType: string, targetId: string, metadata: Record<string, unknown>, ip: string | null): Promise<void> {
    await this.pool.query(`insert into public.audit_logs (actor_id, action, target_type, target_id, metadata, ip) values ($1,$2,$3,$4,$5::jsonb,$6)`, [actorId, action, targetType, targetId, JSON.stringify(metadata), ip]);
  }

  async overview() {
    const q = async (sql: string) => (await this.pool.query(sql)).rows[0] as any;
    const [users, tests, bugs, security, emails] = await Promise.all([
      q(`select count(*)::int as total, count(*) filter (where account_status='suspended')::int as suspended, count(*) filter (where created_at > now() - interval '7 days')::int as new_7d from public.profiles`),
      q(`select count(*)::int as total, count(*) filter (where status in ('queued','running'))::int as active, count(*) filter (where status='completed')::int as completed,
                count(*) filter (where status='failed')::int as failed, count(*) filter (where created_at > now() - interval '24 hours')::int as last_24h from public.test_jobs`),
      q(`select count(*)::int as total, count(*) filter (where severity='critical')::int as critical, count(*) filter (where severity='high')::int as high from public.bug_reports`),
      q(`select (select count(*)::int from public.security_events where acknowledged_at is null and risk_level in ('high','critical')) as open_alerts,
                (select count(*)::int from public.login_events where success=false and coalesce(reason,'')<>'throttled' and created_at > now() - interval '24 hours') as failed_logins_24h,
                (select count(*)::int from public.login_events where success=true and created_at > now() - interval '24 hours') as logins_24h`),
      q(`select count(*) filter (where status='failed' and created_at > now() - interval '24 hours')::int as failed_24h, count(*) filter (where created_at > now() - interval '24 hours')::int as sent_24h from public.email_notifications`),
    ]);
    return {
      users: { total: users.total, suspended: users.suspended, newLast7Days: users.new_7d },
      tests: { total: tests.total, active: tests.active, completed: tests.completed, failed: tests.failed, last24h: tests.last_24h },
      bugs: { total: bugs.total, critical: bugs.critical, high: bugs.high },
      security: { openHighAlerts: security.open_alerts, failedLogins24h: security.failed_logins_24h, logins24h: security.logins_24h },
      emails: { last24h: emails.sent_24h, failedLast24h: emails.failed_24h },
    };
  }

  async analytics(days: number) {
    const d = Math.min(90, Math.max(1, Math.floor(days) || 14));
    const [perDay, severities, categories, duration, signups] = await Promise.all([
      this.pool.query(
        `select to_char(g.day, 'YYYY-MM-DD') as day, coalesce(t.total,0)::int as total, coalesce(t.completed,0)::int as completed, coalesce(t.failed,0)::int as failed
           from generate_series(date_trunc('day', now()) - make_interval(days => $1::int - 1), date_trunc('day', now()), interval '1 day') as g(day)
           left join (select date_trunc('day', created_at) as day, count(*) as total, count(*) filter (where status='completed') as completed, count(*) filter (where status='failed') as failed
                        from public.test_jobs group by 1) t on t.day = g.day order by g.day`,
        [d],
      ),
      this.pool.query(`select severity, count(*)::int as n from public.bug_reports where created_at > now() - make_interval(days => $1::int) group by severity`, [d]),
      this.pool.query(`select category, count(*)::int as n from public.bug_reports where created_at > now() - make_interval(days => $1::int) group by category order by n desc limit 8`, [d]),
      this.pool.query(`select coalesce(round(avg(extract(epoch from (finished_at - started_at))))::int, 0) as avg_seconds from public.test_jobs where status='completed' and started_at is not null and created_at > now() - make_interval(days => $1::int)`, [d]),
      this.pool.query(
        `select to_char(g.day, 'YYYY-MM-DD') as day, coalesce(s.n,0)::int as n
           from generate_series(date_trunc('day', now()) - make_interval(days => $1::int - 1), date_trunc('day', now()), interval '1 day') as g(day)
           left join (select date_trunc('day', created_at) as day, count(*) as n from public.profiles group by 1) s on s.day = g.day order by g.day`,
        [d],
      ),
    ]);
    return {
      days: d,
      testsPerDay: perDay.rows,
      signupsPerDay: signups.rows,
      severity: Object.fromEntries(severities.rows.map((r: any) => [r.severity, r.n])),
      topCategories: categories.rows.map((r: any) => ({ category: r.category, count: r.n })),
      avgDurationSeconds: duration.rows[0]?.avg_seconds ?? 0,
    };
  }

  async system() {
    let db = false;
    try {
      await this.pool.query('select 1');
      db = true;
    } catch {
      /* reported */
    }
    const redis = await this.queue.ping().catch(() => false);
    const jobs = await this.pool.query(
      `select count(*) filter (where status='queued')::int as queued, count(*) filter (where status='running')::int as running,
              count(*) filter (where status='running' and (heartbeat_at is null or heartbeat_at < now() - interval '60 seconds'))::int as stale,
              count(*) filter (where status='queued' and queued_at < now() - interval '2 minutes')::int as waiting_long,
              (select count(distinct locked_by)::int from public.test_jobs where status='running' and heartbeat_at > now() - interval '60 seconds') as live_workers
         from public.test_jobs where status in ('queued','running')`,
    );
    const j = jobs.rows[0];
    return { database: db, redis, queue: { queued: j.queued, running: j.running, staleRunning: j.stale, waitingOverTwoMinutes: j.waiting_long, activeWorkers: j.live_workers }, ai: { configured: this.flags.aiConfigured }, email: { configured: this.flags.emailConfigured }, adminAlertEmailConfigured: this.flags.adminEmailConfigured, authProvider: this.flags.authProvider };
  }

  // ----------------------------------------------------------------- users
  async listUsers(q: { search?: string; status?: string; page?: unknown; pageSize?: unknown }) {
    const { page, pageSize, offset } = clampPage(q.page, q.pageSize);
    const search = (q.search ?? '').trim().slice(0, 100);
    const status = q.status === 'suspended' || q.status === 'active' ? q.status : null;
    const like = search ? `%${search.replace(/[\\%_]/g, '\\$&')}%` : null;
    const where = `($1::text is null or lower(p.email) like lower($1) or lower(p.full_name) like lower($1)) and ($2::text is null or p.account_status = $2)`;
    const [rows, total] = await Promise.all([
      this.pool.query(
        `select p.id, p.email, p.full_name, p.account_status, p.suspended_reason, p.email_verified_at, p.last_login_at, p.created_at,
                exists (select 1 from public.user_roles r where r.user_id = p.id and r.role='admin') as is_admin,
                (select count(*)::int from public.test_jobs j where j.user_id = p.id) as tests
           from public.profiles p where ${where} order by p.created_at desc limit $3 offset $4`,
        [like, status, pageSize, offset],
      ),
      this.pool.query(`select count(*)::int as n from public.profiles p where ${where}`, [like, status]),
    ]);
    return {
      page, pageSize, total: total.rows[0].n,
      items: rows.rows.map((r: any) => ({ id: r.id, email: r.email, fullName: r.full_name, status: r.account_status, suspendedReason: r.suspended_reason, verified: Boolean(r.email_verified_at), role: r.is_admin ? 'admin' : 'user', lastLoginAt: iso(r.last_login_at), createdAt: iso(r.created_at), tests: r.tests })),
    };
  }

  async setUserStatus(actor: { id: string; ip: string | null }, userId: string, status: 'active' | 'suspended', reason: string | null) {
    if (userId === actor.id) throw badRequest('You cannot change the status of your own account.');
    const target = await this.pool.query('select id from public.profiles where id = $1', [userId]);
    if (!target.rows[0]) throw notFound('User not found.');
    await this.pool.query(`update public.profiles set account_status = $2, suspended_reason = $3 where id = $1`, [userId, status, status === 'suspended' ? reason : null]);
    if (status === 'suspended') await this.identity.revokeAllSessions(userId).catch(() => undefined);
    await this.audit(actor.id, status === 'suspended' ? 'user.suspended' : 'user.reactivated', 'user', userId, { reason }, actor.ip);
  }

  async setUserRole(actor: { id: string; ip: string | null }, userId: string, role: 'user' | 'admin') {
    if (userId === actor.id) throw badRequest('You cannot change your own role.');
    const target = await this.pool.query('select id from public.profiles where id = $1', [userId]);
    if (!target.rows[0]) throw notFound('User not found.');
    if (role === 'admin') {
      await this.pool.query(`insert into public.user_roles (user_id, role, granted_by) values ($1,'admin',$2) on conflict do nothing`, [userId, actor.id]);
    } else {
      const admins = await this.pool.query<{ n: number }>(`select count(*)::int as n from public.user_roles where role = 'admin'`);
      if ((admins.rows[0]?.n ?? 0) <= 1) throw conflict('There must always be at least one administrator.');
      await this.pool.query(`delete from public.user_roles where user_id = $1 and role = 'admin'`, [userId]);
    }
    await this.audit(actor.id, role === 'admin' ? 'user.promoted' : 'user.demoted', 'user', userId, {}, actor.ip);
  }

  // ----------------------------------------------------------------- lists
  async listTests(q: { status?: string; page?: unknown; pageSize?: unknown }) {
    const { page, pageSize, offset } = clampPage(q.page, q.pageSize);
    const status = ['queued', 'running', 'completed', 'failed', 'cancelled'].includes(q.status ?? '') ? q.status! : null;
    const [rows, total] = await Promise.all([
      this.pool.query(
        `select j.id, j.hostname, j.target_url, j.status, j.progress_pct, j.created_at, j.finished_at, j.error_message, j.summary, p.email
           from public.test_jobs j join public.profiles p on p.id = j.user_id where ($1::text is null or j.status = $1) order by j.created_at desc limit $2 offset $3`,
        [status, pageSize, offset],
      ),
      this.pool.query(`select count(*)::int as n from public.test_jobs where ($1::text is null or status = $1)`, [status]),
    ]);
    return { page, pageSize, total: total.rows[0].n, items: rows.rows.map((r: any) => ({ id: r.id, hostname: r.hostname, targetUrl: r.target_url, status: r.status, progressPct: r.progress_pct, createdAt: iso(r.created_at), finishedAt: iso(r.finished_at), errorMessage: r.error_message, bugs: r.summary?.bugs ?? null, overall: r.summary?.overall ?? null, userEmail: r.email })) };
  }

  async listSecurityEvents(q: { acknowledged?: string; page?: unknown; pageSize?: unknown }) {
    const { page, pageSize, offset } = clampPage(q.page, q.pageSize);
    const ack = q.acknowledged === 'true' ? true : q.acknowledged === 'false' ? false : null;
    const where = `($1::boolean is null or (acknowledged_at is not null) = $1)`;
    const [rows, total] = await Promise.all([
      this.pool.query(`select * from public.security_events where ${where} order by created_at desc limit $2 offset $3`, [ack, pageSize, offset]),
      this.pool.query(`select count(*)::int as n from public.security_events where ${where}`, [ack]),
    ]);
    return { page, pageSize, total: total.rows[0].n, items: rows.rows.map((r: any) => ({ id: r.id, kind: r.kind, riskLevel: r.risk_level, email: r.email, attemptCount: r.attempt_count, ip: r.ip, userAgent: r.user_agent, actionTaken: r.action_taken, details: r.details, acknowledged: Boolean(r.acknowledged_at), createdAt: iso(r.created_at) })) };
  }

  async acknowledgeSecurityEvent(actor: { id: string; ip: string | null }, id: string) {
    const r = await this.pool.query(`update public.security_events set acknowledged_by = $2, acknowledged_at = now() where id = $1 and acknowledged_at is null returning id`, [id, actor.id]);
    if (!r.rows[0]) {
      const exists = await this.pool.query('select 1 from public.security_events where id = $1', [id]);
      if (!exists.rows[0]) throw notFound('Security event not found.');
      return;
    }
    await this.audit(actor.id, 'security_event.acknowledged', 'security_event', id, {}, actor.ip);
  }

  async listLogins(q: { success?: string; page?: unknown; pageSize?: unknown }) {
    const { page, pageSize, offset } = clampPage(q.page, q.pageSize);
    const success = q.success === 'true' ? true : q.success === 'false' ? false : null;
    const [rows, total] = await Promise.all([
      this.pool.query(`select id, email, success, reason, ip, user_agent, created_at from public.login_events where ($1::boolean is null or success = $1) order by created_at desc, id desc limit $2 offset $3`, [success, pageSize, offset]),
      this.pool.query(`select count(*)::int as n from public.login_events where ($1::boolean is null or success = $1)`, [success]),
    ]);
    return { page, pageSize, total: total.rows[0].n, items: rows.rows.map((r: any) => ({ id: Number(r.id), email: r.email, success: r.success, reason: r.reason, ip: r.ip, userAgent: r.user_agent, createdAt: iso(r.created_at) })) };
  }

  async listAudit(q: { page?: unknown; pageSize?: unknown }) {
    const { page, pageSize, offset } = clampPage(q.page, q.pageSize);
    const [rows, total] = await Promise.all([
      this.pool.query(`select a.id, a.action, a.target_type, a.target_id, a.metadata, a.ip, a.created_at, p.email as actor_email from public.audit_logs a left join public.profiles p on p.id = a.actor_id order by a.created_at desc, a.id desc limit $1 offset $2`, [pageSize, offset]),
      this.pool.query(`select count(*)::int as n from public.audit_logs`),
    ]);
    return { page, pageSize, total: total.rows[0].n, items: rows.rows.map((r: any) => ({ id: Number(r.id), action: r.action, targetType: r.target_type, targetId: r.target_id, metadata: r.metadata, ip: r.ip, actorEmail: r.actor_email, createdAt: iso(r.created_at) })) };
  }

  async listEmails(q: { status?: string; page?: unknown; pageSize?: unknown }) {
    const { page, pageSize, offset } = clampPage(q.page, q.pageSize);
    const status = ['pending', 'sent', 'failed'].includes(q.status ?? '') ? q.status! : null;
    const [rows, total] = await Promise.all([
      this.pool.query(`select id, to_email, template, subject, status, error, created_at, sent_at from public.email_notifications where ($1::text is null or status = $1) order by created_at desc limit $2 offset $3`, [status, pageSize, offset]),
      this.pool.query(`select count(*)::int as n from public.email_notifications where ($1::text is null or status = $1)`, [status]),
    ]);
    return { page, pageSize, total: total.rows[0].n, items: rows.rows.map((r: any) => ({ id: r.id, to: r.to_email, template: r.template, subject: r.subject, status: r.status, error: r.error, createdAt: iso(r.created_at), sentAt: iso(r.sent_at) })) };
  }

  // ----------------------------------------------------------------- settings
  async getSettings() {
    const { rows } = await this.pool.query(`select key, value, description, updated_at from public.app_settings order by key`);
    return { items: rows.filter((r: any) => r.key in SETTING_SCHEMAS).map((r: any) => ({ key: r.key, value: r.value, description: r.description, updatedAt: iso(r.updated_at) })) };
  }

  async putSetting(actor: { id: string; ip: string | null }, key: string, value: unknown) {
    const schema = SETTING_SCHEMAS[key];
    if (!schema) throw notFound('Unknown setting.');
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid value.', parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
    const before = await this.pool.query('select value from public.app_settings where key = $1', [key]);
    await this.pool.query(
      `insert into public.app_settings (key, value, updated_by) values ($1,$2::jsonb,$3) on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by`,
      [key, JSON.stringify(parsed.data), actor.id],
    );
    await this.audit(actor.id, 'setting.updated', 'setting', key, { before: before.rows[0]?.value ?? null, after: parsed.data }, actor.ip);
    return parsed.data;
  }
}
