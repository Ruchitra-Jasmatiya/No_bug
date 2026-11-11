import type pg from 'pg';
import {
  EMPTY_COUNTS,
  MODULE_BY_ID,
  MODULE_DEFINITIONS,
  type CheckOutcome,
  type JobSummary,
  type ModuleId,
  type ModuleStatus,
  type OverallResult,
  type ResultCounts,
  type ResultStatus,
} from '@nba/shared';

export interface JobRow {
  id: string;
  project_id: string;
  user_id: string;
  target_url: string;
  hostname: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  progress_pct: number;
  selected_modules: ModuleId[];
  current_module: ModuleId | null;
  last_completed_module: ModuleId | null;
  options: Record<string, unknown>;
  attempt: number;
  max_attempts: number;
  locked_by: string | null;
  heartbeat_at: Date | null;
  cancel_requested: boolean;
}

export interface ModuleRow {
  id: string;
  job_id: string;
  module_id: ModuleId;
  position: number;
  status: ModuleStatus;
  attempt: number;
  note: string | null;
  error_message: string | null;
  checkpoint: Record<string, unknown>;
}

export interface ModuleSettlement {
  status: Extract<ModuleStatus, 'completed' | 'failed' | 'skipped' | 'blocked'>;
  note?: string | null;
  error?: string | null;
  checkpoint?: Record<string, unknown>;
  outcomes: CheckOutcome[];
}

export type ClaimResult =
  | { kind: 'claimed'; job: JobRow }
  | { kind: 'missing' }
  | { kind: 'terminal'; status: JobRow['status'] }
  | { kind: 'held'; lockedBy: string | null }
  | { kind: 'exhausted' };

export interface AppSettings {
  timeouts: { jobMs: number; moduleMs: number; navigationMs: number };
  crawl: { maxPages: number; maxDepth: number; maxDownloadBytes: number };
  ai: { maxFindings: number };
}

export const DEFAULT_SETTINGS: AppSettings = {
  timeouts: { jobMs: 600_000, moduleMs: 120_000, navigationMs: 30_000 },
  crawl: { maxPages: 10, maxDepth: 1, maxDownloadBytes: 5 * 1024 * 1024 },
  ai: { maxFindings: 25 },
};

const MAX_EVIDENCE_CHARS = 20_000;
const MAX_MESSAGE_CHARS = 2_000;
const DEFAULT_FIX = 'Review the evidence above, correct the underlying cause, then run the test again to verify the fix.';

function capEvidence(evidence: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!evidence) return {};
  const json = JSON.stringify(evidence);
  if (json.length <= MAX_EVIDENCE_CHARS) return evidence;
  return { truncated: true, originalSize: json.length, preview: json.slice(0, MAX_EVIDENCE_CHARS) };
}

export function deriveOverall(counts: ResultCounts): OverallResult {
  if (counts.fail > 0) return 'issues_found';
  if (counts.warning > 0) return 'warnings_only';
  if (counts.pass === 0) return 'incomplete';
  return 'no_issues_detected';
}

export class Store {
  constructor(private readonly pool: pg.Pool) {}

  async getBaseline(userId: string, pageUrl: string, viewport: string): Promise<Buffer | null> {
    const r = await this.pool.query('select image from public.visual_baselines where user_id=$1 and page_url=$2 and viewport=$3', [userId, pageUrl, viewport]);
    return r.rows[0]?.image ?? null;
  }

  async saveBaseline(userId: string, jobId: string, pageUrl: string, viewport: string, width: number, height: number, image: Buffer): Promise<void> {
    await this.pool.query(
      `insert into public.visual_baselines (user_id, page_url, viewport, width, height, image, job_id) values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (user_id, page_url, viewport) do nothing`,
      [userId, pageUrl, viewport, width, height, image, jobId],
    );
  }

  // --------------------------------------------------------------------- settings
  async loadSettings(): Promise<AppSettings> {
    try {
      const { rows } = await this.pool.query<{ key: string; value: Record<string, number> }>(
        `select key, value from public.app_settings where key in ('timeouts','crawl_limits','ai')`,
      );
      const by = new Map(rows.map((r) => [r.key, r.value]));
      const t = by.get('timeouts');
      const c = by.get('crawl_limits');
      const a = by.get('ai');
      return {
        timeouts: {
          jobMs: Number(t?.job_ms) || DEFAULT_SETTINGS.timeouts.jobMs,
          moduleMs: Number(t?.module_ms) || DEFAULT_SETTINGS.timeouts.moduleMs,
          navigationMs: Number(t?.navigation_ms) || DEFAULT_SETTINGS.timeouts.navigationMs,
        },
        crawl: {
          maxPages: Number(c?.max_pages) || DEFAULT_SETTINGS.crawl.maxPages,
          maxDepth: Number(c?.max_depth) || DEFAULT_SETTINGS.crawl.maxDepth,
          maxDownloadBytes: Number(c?.max_download_bytes) || DEFAULT_SETTINGS.crawl.maxDownloadBytes,
        },
        ai: { maxFindings: Math.min(100, Math.max(1, Number(a?.max_findings_per_job) || DEFAULT_SETTINGS.ai.maxFindings)) },
      };
    } catch {
      return DEFAULT_SETTINGS;
    }
  }

  // --------------------------------------------------------------------- job lifecycle
  async getJob(jobId: string): Promise<JobRow | null> {
    const { rows } = await this.pool.query<JobRow>('select * from public.test_jobs where id = $1', [jobId]);
    return rows[0] ?? null;
  }

  /**
   * Atomically take ownership of a job. Ownership is granted when the job is queued, already ours, unowned,
   * or its previous owner stopped heart-beating (crashed). Terminal jobs are never claimed, which makes
   * redelivery of a queue message harmless.
   */
  async claimJob(jobId: string, workerId: string, staleAfterMs: number): Promise<ClaimResult> {
    const { rows } = await this.pool.query<JobRow>(
      `update public.test_jobs
          set status = 'running', locked_by = $2, heartbeat_at = now(),
              started_at = coalesce(started_at, now()), attempt = attempt + 1, error_message = null
        where id = $1
          and status in ('queued', 'running')
          and attempt < max_attempts
          and (status = 'queued' or locked_by is null or locked_by = $2 or heartbeat_at is null
               or heartbeat_at < now() - make_interval(secs => $3::float8 / 1000))
        returning *`,
      [jobId, workerId, staleAfterMs],
    );
    if (rows[0]) return { kind: 'claimed', job: rows[0] };

    const current = await this.getJob(jobId);
    if (!current) return { kind: 'missing' };
    if (current.status !== 'queued' && current.status !== 'running') return { kind: 'terminal', status: current.status };
    if (current.attempt >= current.max_attempts) return { kind: 'exhausted' };
    return { kind: 'held', lockedBy: current.locked_by };
  }

  /** Returns whether this worker still owns the job and whether a cancel was requested. */
  async heartbeat(jobId: string, workerId: string): Promise<{ owned: boolean; cancelRequested: boolean }> {
    const { rows } = await this.pool.query<{ cancel_requested: boolean }>(
      `update public.test_jobs set heartbeat_at = now()
        where id = $1 and locked_by = $2 and status = 'running' returning cancel_requested`,
      [jobId, workerId],
    );
    return { owned: rows.length > 0, cancelRequested: rows[0]?.cancel_requested ?? false };
  }

  /** Hand a job back (graceful shutdown) so another worker can claim it immediately. */
  async releaseJob(jobId: string, workerId: string): Promise<void> {
    await this.pool.query(
      `update public.test_jobs set locked_by = null, heartbeat_at = null, attempt = greatest(attempt - 1, 0)
        where id = $1 and locked_by = $2 and status = 'running'`,
      [jobId, workerId],
    );
  }

  async failExhausted(jobId: string): Promise<void> {
    await this.pool.query(
      `update public.test_jobs set status = 'failed', finished_at = now(), current_module = null,
              error_message = 'The test could not be completed after several attempts. Please run it again.'
        where id = $1 and status in ('queued', 'running')`,
      [jobId],
    );
  }

  async finishJob(
    jobId: string,
    workerId: string,
    status: 'completed' | 'cancelled' | 'failed',
    errorMessage?: string,
  ): Promise<JobSummary | null> {
    const summary = await this.computeSummary(jobId);
    const { rowCount } = await this.pool.query(
      `update public.test_jobs
          set status = $3, finished_at = now(), current_module = null, error_message = $4,
              progress_pct = case when $3 = 'completed' then 100 else progress_pct end,
              summary = $5::jsonb, locked_by = null
        where id = $1 and locked_by = $2 and status = 'running'`,
      [jobId, workerId, status, errorMessage ?? null, JSON.stringify(summary)],
    );
    return rowCount ? summary : null;
  }

  async computeSummary(jobId: string): Promise<JobSummary> {
    const counts: ResultCounts = { ...EMPTY_COUNTS };
    const res = await this.pool.query<{ status: ResultStatus; n: number }>(
      'select status, count(*)::int as n from public.test_results where job_id = $1 group by status',
      [jobId],
    );
    for (const r of res.rows) counts[r.status] = r.n;
    const bugs = await this.pool.query<{ n: number }>('select count(*)::int as n from public.bug_reports where job_id = $1', [jobId]);
    const gaps = await this.pool.query<{ n: number }>(
      `select count(*)::int as n from public.test_modules where job_id = $1 and module_id <> 'ai_analysis' and status in ('skipped','blocked','failed')`,
      [jobId],
    );
    return {
      counts,
      bugs: bugs.rows[0]?.n ?? 0,
      overall: deriveOverall(counts),
      incomplete: (gaps.rows[0]?.n ?? 0) > 0,
      generatedAt: new Date().toISOString(),
    };
  }

  // --------------------------------------------------------------------- modules (checkpoints)
  async ensureModules(job: JobRow): Promise<void> {
    const ordered = MODULE_DEFINITIONS.filter((m) => job.selected_modules.includes(m.id));
    await this.pool.query(
      `insert into public.test_modules (job_id, module_id, position)
       select $1, t.m, t.p from unnest($2::text[], $3::int[]) as t(m, p)
       on conflict (job_id, module_id) do nothing`,
      [job.id, ordered.map((m) => m.id), ordered.map((m) => MODULE_DEFINITIONS.findIndex((d) => d.id === m.id))],
    );
  }

  async getModules(jobId: string): Promise<ModuleRow[]> {
    const { rows } = await this.pool.query<ModuleRow>('select * from public.test_modules where job_id = $1 order by position', [jobId]);
    return rows;
  }

  /** Mark a module as running and count the attempt. Returns the new attempt number. */
  async startModule(jobId: string, moduleId: ModuleId): Promise<number> {
    const { rows } = await this.pool.query<{ attempt: number }>(
      `update public.test_modules
          set status = 'running', attempt = attempt + 1, started_at = now(), finished_at = null, error_message = null
        where job_id = $1 and module_id = $2 and status in ('pending', 'running') returning attempt`,
      [jobId, moduleId],
    );
    await this.pool.query('update public.test_jobs set current_module = $2 where id = $1', [jobId, moduleId]);
    return rows[0]?.attempt ?? 0;
  }

  /** Give a module back (graceful shutdown) without penalising its attempt count. */
  async releaseModule(jobId: string, moduleId: ModuleId): Promise<void> {
    await this.pool.query(
      `update public.test_modules set status = 'pending', attempt = greatest(attempt - 1, 0)
        where job_id = $1 and module_id = $2 and status = 'running'`,
      [jobId, moduleId],
    );
  }

  /**
   * Persist a module's outcomes and settle it, atomically. Results are keyed by
   * (job, module, check, url) so a retried transaction can never create duplicates.
   * AI analysis lives in a separate column and is never touched here.
   */
  async settleModule(
    job: Pick<JobRow, 'id'>,
    moduleId: ModuleId,
    settlement: ModuleSettlement,
    env: Record<string, unknown>,
    durationMs: number | null,
  ): Promise<ResultCounts> {
    const category = MODULE_BY_ID[moduleId].category;
    const client = await this.pool.connect();
    try {
      await client.query('begin');

      for (const o of settlement.outcomes) {
        const severity = o.severity ?? (o.status === 'fail' ? 'medium' : o.status === 'warning' ? 'low' : o.status === 'info' ? 'informational' : null);
        const confidence = o.confidence ?? (o.status === 'fail' ? 'confirmed' : o.status === 'warning' ? 'potential' : o.status === 'info' ? 'informational' : null);
        const evidence = capEvidence(o.evidence);
        const message = o.message.slice(0, MAX_MESSAGE_CHARS);
        const affectedUrl = o.affectedUrl ?? '';

        const inserted = await client.query<{ id: string }>(
          `insert into public.test_results
             (job_id, module_id, category, check_key, title, status, severity, confidence, affected_url, message, evidence)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           on conflict (job_id, module_id, check_key, affected_url) do update
             set title = excluded.title, status = excluded.status, severity = excluded.severity,
                 confidence = excluded.confidence, message = excluded.message, evidence = excluded.evidence
           returning id`,
          [job.id, moduleId, category, o.checkKey, o.title, o.status, severity, confidence, affectedUrl, message, JSON.stringify(evidence)],
        );
        const resultId = inserted.rows[0]!.id;

        if ((o.status === 'fail' || o.status === 'warning') && severity && confidence) {
          await client.query(
            `insert into public.bug_reports
               (job_id, result_id, category, severity, confidence, title, description, affected_url, evidence, environment, suggested_fix)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
             on conflict (result_id) do update
               set severity = excluded.severity, confidence = excluded.confidence, title = excluded.title,
                   description = excluded.description, evidence = excluded.evidence,
                   environment = excluded.environment, suggested_fix = excluded.suggested_fix`,
            [job.id, resultId, category, severity, confidence, o.title, message, affectedUrl, JSON.stringify(evidence), JSON.stringify(env), o.recommendation ?? DEFAULT_FIX],
          );
        }
      }

      const counts: ResultCounts = { ...EMPTY_COUNTS };
      const grouped = await client.query<{ status: ResultStatus; n: number }>(
        'select status, count(*)::int as n from public.test_results where job_id = $1 and module_id = $2 group by status',
        [job.id, moduleId],
      );
      for (const r of grouped.rows) counts[r.status] = r.n;

      await client.query(
        `update public.test_modules
            set status = $3, note = $4, error_message = $5, checkpoint = $6::jsonb, counts = $7::jsonb,
                finished_at = now(), duration_ms = $8,
                started_at = coalesce(started_at, now())
          where job_id = $1 and module_id = $2`,
        [job.id, moduleId, settlement.status, settlement.note ?? null, settlement.error ?? null, JSON.stringify(settlement.checkpoint ?? {}), JSON.stringify(counts), durationMs],
      );

      const modules = await client.query<{ module_id: ModuleId; status: ModuleStatus }>(
        'select module_id, status from public.test_modules where job_id = $1',
        [job.id],
      );
      let total = 0;
      let done = 0;
      for (const m of modules.rows) {
        const w = MODULE_BY_ID[m.module_id]?.weight ?? 1;
        total += w;
        if (['completed', 'failed', 'skipped', 'blocked'].includes(m.status)) done += w;
      }
      const pct = total === 0 ? 0 : Math.min(99, Math.floor((done / total) * 100));
      await client.query(
        `update public.test_jobs
            set progress_pct = greatest(progress_pct, $2), current_module = null,
                last_completed_module = case when $3 = 'completed' then $4 else last_completed_module end
          where id = $1`,
        [job.id, pct, settlement.status, moduleId],
      );

      await client.query('commit');
      return counts;
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  // --------------------------------------------------------------------- logs
  async appendLog(jobId: string, moduleId: ModuleId | null, level: 'debug' | 'info' | 'warn' | 'error', message: string, meta: Record<string, unknown> = {}): Promise<void> {
    await this.pool.query('insert into public.test_logs (job_id, module_id, level, message, meta) values ($1,$2,$3,$4,$5::jsonb)', [
      jobId,
      moduleId,
      level,
      message.slice(0, 2000),
      JSON.stringify(meta),
    ]);
  }

  // --------------------------------------------------------------------- AI analysis
  /** Bugs still waiting for AI analysis, most severe first. */
  async pendingBugsForAi(jobId: string, limit: number): Promise<Array<{ id: string; issue_code: string; category: string; severity: string; confidence: string; title: string; description: string; affected_url: string; evidence: Record<string, unknown>; suggested_fix: string }>> {
    const { rows } = await this.pool.query(
      `select id, issue_code, category, severity, confidence, title, description, affected_url, evidence, suggested_fix
         from public.bug_reports
        where job_id = $1 and ai_status = 'pending'
        order by array_position(array['critical','high','medium','low','informational'], severity), created_at
        limit $2`,
      [jobId, limit],
    );
    return rows;
  }

  /** Stores AI output in its own column. Evidence, severity and status are never touched. */
  async setBugAi(bugId: string, status: 'completed' | 'failed' | 'skipped', analysis: Record<string, unknown> | null): Promise<void> {
    await this.pool.query('update public.bug_reports set ai_status = $2, ai_analysis = $3::jsonb where id = $1', [bugId, status, analysis ? JSON.stringify(analysis) : null]);
  }

  async skipRemainingPendingBugs(jobId: string): Promise<number> {
    const r = await this.pool.query(`update public.bug_reports set ai_status = 'skipped' where job_id = $1 and ai_status = 'pending'`, [jobId]);
    return r.rowCount ?? 0;
  }

  // --------------------------------------------------------------------- recovery
  /** Jobs that look orphaned: running with no recent heartbeat, or queued and not picked up. */
  async findRecoverableJobs(staleAfterMs: number, queuedGraceMs: number): Promise<Array<{ id: string; status: string }>> {
    const { rows } = await this.pool.query<{ id: string; status: string }>(
      `select id, status from public.test_jobs
        where (status = 'running' and (heartbeat_at is null or heartbeat_at < now() - make_interval(secs => $1::float8 / 1000)))
           or (status = 'queued' and queued_at < now() - make_interval(secs => $2::float8 / 1000))
        order by queued_at
        limit 50`,
      [staleAfterMs, queuedGraceMs],
    );
    return rows;
  }
}
