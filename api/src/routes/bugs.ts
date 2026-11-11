import { Router } from 'express';
import type pg from 'pg';
import { uuidSchema } from '@nba/shared';
import { notFound } from '../lib/errors.js';
import { toBugDTO } from '../lib/mappers.js';
import { ah } from '../middleware/error.js';
import { currentUser, type Authenticator } from '../middleware/auth.js';

/** GET /api/bugs/:id — one bug report, only for its owner (identical 404 for missing and foreign ids). */
export function createBugsRouter(deps: { pool: pg.Pool; auth: Authenticator }): Router {
  const router = Router();
  router.use(deps.auth.requireAuth);
  router.get('/:id', ah(async (req, res) => {
    const id = uuidSchema.safeParse(req.params.id);
    if (!id.success) throw notFound('Bug not found.');
    const { rows } = await deps.pool.query(
      `select b.* from public.bug_reports b join public.test_jobs j on j.id = b.job_id where b.id = $1 and j.user_id = $2`,
      [id.data, currentUser(req).id],
    );
    if (!rows[0]) throw notFound('Bug not found.');
    res.setHeader('Cache-Control', 'no-store');
    res.json({ bug: toBugDTO(rows[0]) });
  }));
  return router;
}
