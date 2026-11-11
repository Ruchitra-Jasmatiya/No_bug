import { Router } from 'express';
import type pg from 'pg';
import { IMPLEMENTED_MODULES, MODULE_DEFINITIONS } from '@nba/shared';
import { ah } from '../middleware/error.js';
import type { JobQueue } from '../queue/queue.js';
import { loadSettings } from '../services/settings.js';

interface PublicStats {
  testsRun: number;
  issuesFound: number;
  sitesTested: number;
  checksRun: number;
}

export function createPublicRouter(deps: { pool: pg.Pool; queue: JobQueue }): Router {
  const router = Router();
  let statsCache: { at: number; value: PublicStats } | null = null;

  /** Real, anonymous aggregate numbers for the landing page. Nothing about any user or URL is exposed. */
  router.get('/api/public/stats', ah(async (_req, res) => {
    if (!statsCache || Date.now() - statsCache.at > 60_000) {
      const { rows } = await deps.pool.query(
        `select (select count(*) from public.test_jobs where status = 'completed')::int as tests,
                (select count(*) from public.bug_reports)::int as bugs,
                (select count(distinct hostname) from public.test_jobs where status = 'completed')::int as sites,
                (select count(*) from public.test_results)::int as checks`,
      );
      const r = rows[0];
      statsCache = { at: Date.now(), value: { testsRun: r.tests, issuesFound: r.bugs, sitesTested: r.sites, checksRun: r.checks } };
    }
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.json(statsCache.value);
  }));

  router.get('/healthz', ah(async (_req, res) => {
    let db = false;
    try {
      await deps.pool.query('select 1');
      db = true;
    } catch {
      /* reported below */
    }
    const redis = await deps.queue.ping();
    res.status(db && redis ? 200 : 503).json({ ok: db && redis, db, redis });
  }));

  /** What can actually be tested right now. The UI uses this so it never advertises a module that cannot run. */
  router.get('/api/modules', ah(async (_req, res) => {
    const settings = await loadSettings(deps.pool);
    res.json({
      modules: MODULE_DEFINITIONS.map((m) => ({
        id: m.id,
        label: m.label,
        description: m.description,
        category: m.category,
        system: m.system,
        implemented: (IMPLEMENTED_MODULES as readonly string[]).includes(m.id),
        enabled: m.system || settings.enabledModules.includes(m.id),
      })),
    });
  }));

  return router;
}
