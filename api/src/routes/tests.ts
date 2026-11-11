import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import {
  EMPTY_COUNTS,
  NO_ISSUES_MESSAGE,
  SEVERITIES,
  CHECK_CATEGORIES,
  TERMINAL_JOB_STATUSES,
  createTestSchema,
  listQuerySchema,
  progressQuerySchema,
  uuidSchema,
  type ProgressDTO,
  type ReportDTO,
  type ResultCounts,
  type ResultStatus,
  type JobDTO,
} from '@nba/shared';
import { conflict, notFound } from '../lib/errors.js';
import { toBugDTO, toJobDTO, toLogDTO, toModuleDTO, toResultDTO } from '../lib/mappers.js';
import { ah } from '../middleware/error.js';
import { currentUser, type Authenticator } from '../middleware/auth.js';
import type { JobService } from '../services/jobs.js';

export function createTestsRouter(deps: { pool: pg.Pool; jobs: JobService; auth: Authenticator }): Router {
  const { pool, jobs, auth } = deps;
  const router = Router();
  router.use(auth.requireAuth);
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  const idParam = (v: unknown) => uuidSchema.safeParse(v);
  async function ownedJob(userId: string, id: unknown) {
    const parsed = idParam(id);
    if (!parsed.success) throw notFound('Test not found.');
    const { rows } = await pool.query('select * from public.test_jobs where id = $1 and user_id = $2', [parsed.data, userId]);
    if (!rows[0]) throw notFound('Test not found.'); // identical response for "missing" and "someone else's"
    return rows[0];
  }

  router.post('/', ah(async (req, res) => {
    const user = currentUser(req);
    const body = createTestSchema.parse(req.body);
    const { job, created } = await jobs.create({ userId: user.id, url: body.url, modules: body.modules, idempotencyKey: body.idempotencyKey });
    res.status(created ? 202 : 200).json({ job: toJobDTO(job), created });
  }));

  router.get('/', ah(async (req, res) => {
    const user = currentUser(req);
    const { page, pageSize } = listQuerySchema.parse(req.query);
    const [rows, total] = await Promise.all([
      pool.query('select * from public.test_jobs where user_id = $1 order by created_at desc limit $2 offset $3', [user.id, pageSize, (page - 1) * pageSize]),
      pool.query<{ n: number }>('select count(*)::int as n from public.test_jobs where user_id = $1', [user.id]),
    ]);
    res.json({ items: rows.rows.map(toJobDTO), page, pageSize, total: total.rows[0]!.n });
  }));

  /** The most recent unfinished test: lets a returning visitor (or a reopened browser) restore its session. */
  router.get('/active', ah(async (req, res) => {
    const user = currentUser(req);
    const { rows } = await pool.query(`select * from public.test_jobs where user_id = $1 and status in ('queued','running') order by created_at desc limit 5`, [user.id]);
    res.json({ items: rows.map(toJobDTO) });
  }));

  router.get('/:id', ah(async (req, res) => {
    const job = await ownedJob(currentUser(req).id, req.params.id);
    res.json({ job: toJobDTO(job) });
  }));

  router.get('/:id/progress', ah(async (req, res) => {
    const job = await ownedJob(currentUser(req).id, req.params.id);
    const { after } = progressQuerySchema.parse(req.query);
    const [modules, counts, logs] = await Promise.all([
      pool.query('select * from public.test_modules where job_id = $1 order by position', [job.id]),
      pool.query<{ status: ResultStatus; n: number }>('select status, count(*)::int as n from public.test_results where job_id = $1 group by status', [job.id]),
      pool.query('select id, module_id, level, message, created_at from public.test_logs where job_id = $1 and id > $2 order by id limit 200', [job.id, after]),
    ]);
    const c: ResultCounts = { ...EMPTY_COUNTS };
    for (const r of counts.rows) c[r.status] = r.n;
    const logDtos = logs.rows.map(toLogDTO);
    const body: ProgressDTO = {
      job: toJobDTO(job),
      modules: modules.rows.map(toModuleDTO),
      counts: c,
      logs: logDtos,
      logCursor: logDtos.length ? logDtos[logDtos.length - 1]!.id : after,
      serverTime: new Date().toISOString(),
    };
    res.json(body);
  }));

  router.post('/:id/resume', ah(async (req, res) => {
    const parsed = idParam(req.params.id);
    if (!parsed.success) throw notFound('Test not found.');
    const result = await jobs.resume(currentUser(req).id, parsed.data);
    if (!result) throw notFound('Test not found.');
    res.json({ job: toJobDTO(result.job), resumed: result.resumed });
  }));

  router.post('/:id/restart', ah(async (req, res) => {
    const parsed = idParam(req.params.id);
    if (!parsed.success) throw notFound('Test not found.');
    const result = await jobs.restart(currentUser(req).id, parsed.data);
    if (!result) throw notFound('Test not found.');
    res.status(202).json({ job: toJobDTO(result.job) });
  }));

  router.post('/:id/cancel', ah(async (req, res) => {
    const user = currentUser(req);
    const job = await ownedJob(user.id, req.params.id);
    const updated = await jobs.cancel(user.id, job.id);
    if (!updated) throw conflict('This test has already finished.', 'already_finished');
    res.json({ job: toJobDTO(updated) });
  }));

  router.get('/:id/report', ah(async (req, res) => {
    const job = await ownedJob(currentUser(req).id, req.params.id);
    const dto = toJobDTO(job);
    if (!TERMINAL_JOB_STATUSES.includes(dto.status)) throw conflict('This test is still running. The report will be ready when it finishes.', 'not_ready');
    const [modules, results, bugs] = await Promise.all([
      pool.query('select * from public.test_modules where job_id = $1 order by position', [job.id]),
      pool.query('select * from public.test_results where job_id = $1 order by module_id, created_at', [job.id]),
      pool.query(`select * from public.bug_reports where job_id = $1 order by array_position(array['critical','high','medium','low','informational'], severity), created_at`, [job.id]),
    ]);
    const summary = dto.summary ?? { counts: { ...EMPTY_COUNTS }, bugs: 0, overall: 'incomplete' as const, incomplete: true, generatedAt: dto.updatedAt };
    const report: ReportDTO = {
      job: dto,
      modules: modules.rows.map(toModuleDTO),
      results: results.rows.map(toResultDTO),
      bugs: bugs.rows.map(toBugDTO),
      summary,
      message: reportMessage(dto, summary.bugs),
    };
    res.json(report);
  }));

  const bugFilter = z.object({ severity: z.enum(SEVERITIES).optional(), category: z.enum(CHECK_CATEGORIES).optional() });
  router.get('/:id/bugs', ah(async (req, res) => {
    const job = await ownedJob(currentUser(req).id, req.params.id);
    const f = bugFilter.parse(req.query);
    const { rows } = await pool.query(
      `select * from public.bug_reports where job_id = $1 and ($2::text is null or severity = $2) and ($3::text is null or category = $3)
        order by array_position(array['critical','high','medium','low','informational'], severity), created_at`,
      [job.id, f.severity ?? null, f.category ?? null],
    );
    res.json({ items: rows.map(toBugDTO) });
  }));

  return router;
}

export function reportMessage(job: JobDTO, bugs: number): string {
  if (job.status === 'cancelled') return 'This test was cancelled before it finished. Results below are partial.';
  if (job.status === 'failed') return job.errorMessage ?? 'This test could not be completed.';
  const s = job.summary;
  if (!s) return 'This test could not be completed.';
  switch (s.overall) {
    case 'issues_found':
      return `${bugs} issue${bugs === 1 ? '' : 's'} detected in the tests performed.${s.incomplete ? ' Some modules were skipped or unavailable, so this report is not exhaustive.' : ''}`;
    case 'warnings_only':
      return `No failures, but ${bugs} warning${bugs === 1 ? '' : 's'} detected in the tests performed.${s.incomplete ? ' Some modules were skipped or unavailable.' : ''}`;
    case 'no_issues_detected':
      return s.incomplete ? `${NO_ISSUES_MESSAGE} Some modules were skipped or unavailable, so this does not mean the website is free of bugs.` : NO_ISSUES_MESSAGE;
    default:
      return 'The test could not be completed, so no conclusion can be drawn about this website.';
  }
}
