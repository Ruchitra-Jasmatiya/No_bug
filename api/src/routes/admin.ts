import { Router } from 'express';
import { z } from 'zod';
import { uuidSchema } from '@nba/shared';
import { notFound } from '../lib/errors.js';
import { ah } from '../middleware/error.js';
import { currentUser, type Authenticator } from '../middleware/auth.js';
import type { AdminService } from '../services/admin.js';

const statusBody = z.object({ status: z.enum(['active', 'suspended']), reason: z.string().trim().max(300).optional() });
const roleBody = z.object({ role: z.enum(['user', 'admin']) });
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

export function createAdminRouter(deps: { admin: AdminService; auth: Authenticator }): Router {
  const { admin, auth } = deps;
  const router = Router();
  // Every admin route is guarded by requireAdmin, which re-reads the role from the database on each request.
  router.use(auth.requireAdmin);
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  const actor = (req: import('express').Request) => ({ id: currentUser(req).id, ip: req.ip ?? null });
  const idOr404 = (v: unknown) => {
    const p = uuidSchema.safeParse(v);
    if (!p.success) throw notFound();
    return p.data;
  };

  router.get('/overview', ah(async (_req, res) => res.json(await admin.overview())));
  router.get('/analytics', ah(async (req, res) => res.json(await admin.analytics(Number(req.query.days) || 14))));
  router.get('/system', ah(async (_req, res) => res.json(await admin.system())));
  router.get('/users', ah(async (req, res) => res.json(await admin.listUsers({ search: str(req.query.search), status: str(req.query.status), page: req.query.page, pageSize: req.query.pageSize }))));
  router.patch('/users/:id/status', ah(async (req, res) => {
    const b = statusBody.parse(req.body);
    await admin.setUserStatus(actor(req), idOr404(req.params.id), b.status, b.reason ?? null);
    res.json({ ok: true });
  }));
  router.patch('/users/:id/role', ah(async (req, res) => {
    await admin.setUserRole(actor(req), idOr404(req.params.id), roleBody.parse(req.body).role);
    res.json({ ok: true });
  }));
  router.get('/tests', ah(async (req, res) => res.json(await admin.listTests({ status: str(req.query.status), page: req.query.page, pageSize: req.query.pageSize }))));
  router.get('/security/events', ah(async (req, res) => res.json(await admin.listSecurityEvents({ acknowledged: str(req.query.acknowledged), page: req.query.page, pageSize: req.query.pageSize }))));
  router.post('/security/events/:id/acknowledge', ah(async (req, res) => {
    await admin.acknowledgeSecurityEvent(actor(req), idOr404(req.params.id));
    res.json({ ok: true });
  }));
  router.get('/security/logins', ah(async (req, res) => res.json(await admin.listLogins({ success: str(req.query.success), page: req.query.page, pageSize: req.query.pageSize }))));
  router.get('/audit-logs', ah(async (req, res) => res.json(await admin.listAudit({ page: req.query.page, pageSize: req.query.pageSize }))));
  router.get('/emails', ah(async (req, res) => res.json(await admin.listEmails({ status: str(req.query.status), page: req.query.page, pageSize: req.query.pageSize }))));
  router.get('/settings', ah(async (_req, res) => res.json(await admin.getSettings())));
  router.put('/settings/:key', ah(async (req, res) => {
    const value = await admin.putSetting(actor(req), String(req.params.key), req.body?.value);
    res.json({ key: req.params.key, value });
  }));

  return router;
}
