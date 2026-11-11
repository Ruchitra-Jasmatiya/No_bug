import type pg from 'pg';
import { MODULE_DEFINITIONS, resolveModules, type ModuleId } from '@nba/shared';
import { type NetPolicy, type Resolver } from '@nba/shared/net';
import { conflict, tooMany, unprocessable } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import { validateTarget } from '../lib/target.js';
import type { JobQueue } from '../queue/queue.js';
import { loadSettings } from './settings.js';

export interface JobServiceDeps {
  pool: pg.Pool;
  queue: JobQueue;
  policy: NetPolicy;
  logger: Logger;
  resolver?: Resolver;
}

export interface CreateJobInput {
  userId: string;
  url: string;
  modules?: ModuleId[];
  idempotencyKey?: string;
  restartOf?: string;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export class JobService {
  constructor(private readonly d: JobServiceDeps) {}

  async create(input: CreateJobInput): Promise<{ job: any; created: boolean }> {
    const { pool } = this.d;
    const target = await validateTarget(input.url, this.d.policy, this.d.resolver);
    const settings = await loadSettings(pool);

    // Module selection is limited to what the administrator has enabled. System modules always run.
    const requested = input.modules && input.modules.length > 0 ? input.modules : settings.enabledModules;
    const disabled = requested.filter((m) => !settings.enabledModules.includes(m) && !MODULE_DEFINITIONS.find((d) => d.id === m)?.system);
    if (disabled.length > 0) {
      throw unprocessable(`These test modules are not available: ${disabled.join(', ')}.`, 'module_unavailable');
    }
    const selected = resolveModules(requested);

    const client = await pool.connect();
    try {
      await client.query('begin');
      // Serialise creation per user so concurrent requests cannot slip past the limits.
      await client.query('select pg_advisory_xact_lock(hashtext($1))', [`create-job:${input.userId}`]);

      if (input.idempotencyKey) {
        const existing = await client.query(`select * from public.test_jobs where user_id = $1 and idempotency_key = $2`, [input.userId, input.idempotencyKey]);
        if (existing.rows[0]) {
          await client.query('commit');
          return { job: existing.rows[0], created: false };
        }
      }

      // The job being replaced by a restart does not count against the limit.
      const active = await client.query<{ n: number }>(
        `select count(*)::int as n from public.test_jobs where user_id = $1 and status in ('queued','running') and ($2::uuid is null or id <> $2::uuid)`,
        [input.userId, input.restartOf ?? null],
      );
      if ((active.rows[0]?.n ?? 0) >= settings.maxActiveJobsPerUser) {
        throw conflict(`You already have ${active.rows[0]!.n} test(s) running. Wait for one to finish or cancel it first.`, 'too_many_active_jobs');
      }
      const perUser = await client.query<{ n: number }>(`select count(*)::int as n from public.test_jobs where user_id = $1 and created_at > now() - interval '1 hour'`, [input.userId]);
      if ((perUser.rows[0]?.n ?? 0) >= settings.testsPerHourPerUser) {
        throw tooMany('You have reached the hourly test limit. Please try again later.');
      }
      const perDomain = await client.query<{ n: number }>(`select count(*)::int as n from public.test_jobs where hostname = $1 and created_at > now() - interval '1 hour'`, [target.hostname]);
      if ((perDomain.rows[0]?.n ?? 0) >= settings.testsPerHourPerDomain) {
        throw tooMany('This website has been tested too many times in the last hour. Please try again later.');
      }

      const project = await client.query<{ id: string }>(
        `insert into public.test_projects (user_id, name, base_url, hostname) values ($1,$2,$3,$4)
         on conflict (user_id, base_url) do update set updated_at = now() returning id`,
        [input.userId, target.hostname, target.origin + '/', target.hostname],
      );
      const job = await client.query(
        `insert into public.test_jobs (project_id, user_id, target_url, hostname, selected_modules, idempotency_key, restart_of)
         values ($1,$2,$3,$4,$5,$6,$7) returning *`,
        [project.rows[0]!.id, input.userId, target.url, target.hostname, selected, input.idempotencyKey ?? null, input.restartOf ?? null],
      );
      await client.query('commit');

      await this.enqueueSafely(job.rows[0].id);
      return { job: job.rows[0], created: true };
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * The row is already committed. If Redis is briefly unavailable the job simply stays 'queued' and the
   * worker's reaper enqueues it, so a request is never lost and never reported as failed.
   */
  async enqueueSafely(jobId: string): Promise<boolean> {
    try {
      await this.d.queue.enqueue(jobId);
      return true;
    } catch (err) {
      this.d.logger.error({ jobId, err: String(err) }, 'enqueue failed; job stays queued for the reaper');
      return false;
    }
  }

  async cancel(userId: string, jobId: string): Promise<any | null> {
    const { rows } = await this.d.pool.query(
      `update public.test_jobs
          set cancel_requested = true,
              status = case when status = 'queued' then 'cancelled' else status end,
              finished_at = case when status = 'queued' then now() else finished_at end,
              current_module = case when status = 'queued' then null else current_module end
        where id = $1 and user_id = $2 and status in ('queued','running')
        returning *`,
      [jobId, userId],
    );
    if (rows[0]?.status === 'cancelled') await this.d.queue.remove(jobId).catch(() => undefined);
    return rows[0] ?? null;
  }

  /** Make a failed job runnable again from its checkpoints. Completed modules are not rerun. */
  async resume(userId: string, jobId: string): Promise<{ job: any; resumed: boolean } | null> {
    const client = await this.d.pool.connect();
    try {
      await client.query('begin');
      const failed = await client.query(
        `update public.test_jobs
            set status = 'queued', attempt = 0, error_message = null, finished_at = null, cancel_requested = false,
                locked_by = null, heartbeat_at = null, queued_at = now(), summary = null
          where id = $1 and user_id = $2 and status = 'failed' returning *`,
        [jobId, userId],
      );
      if (failed.rows[0]) {
        await client.query(`update public.test_modules set status = 'pending' where job_id = $1 and status = 'running'`, [jobId]);
        await client.query('commit');
        await this.enqueueSafely(jobId);
        return { job: failed.rows[0], resumed: true };
      }
      const current = await client.query(`select * from public.test_jobs where id = $1 and user_id = $2`, [jobId, userId]);
      await client.query('commit');
      const row = current.rows[0];
      if (!row) return null;
      if (row.status === 'queued' || row.status === 'running') {
        await this.enqueueSafely(jobId); // idempotent: no-op while the job is active in the queue
        return { job: row, resumed: false };
      }
      throw conflict(row.status === 'completed' ? 'This test has already finished.' : 'A cancelled test cannot be resumed. Start a new test instead.', 'not_resumable');
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async restart(userId: string, jobId: string): Promise<{ job: any } | null> {
    const { rows } = await this.d.pool.query(`select * from public.test_jobs where id = $1 and user_id = $2`, [jobId, userId]);
    const old = rows[0];
    if (!old) return null;
    // Create first: if the new test cannot be created, the running one is left untouched.
    const { job } = await this.create({ userId, url: old.target_url, modules: old.selected_modules, restartOf: jobId });
    if (old.status === 'queued' || old.status === 'running') await this.cancel(userId, jobId);
    return { job };
  }
}
