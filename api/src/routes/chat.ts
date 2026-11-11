import { Router } from 'express';
import { z } from 'zod';
import { uuidSchema } from '@nba/shared';
import { notFound } from '../lib/errors.js';
import { ah } from '../middleware/error.js';
import { currentUser, type Authenticator } from '../middleware/auth.js';
import type { ChatService } from '../services/chat.js';

const createSchema = z.object({ jobId: uuidSchema.optional().nullable() });
const messageSchema = z.object({ content: z.string().trim().min(1, 'Please type a message.').max(2000, 'Messages can be up to 2000 characters.') });

export function createChatRouter(deps: { chat: ChatService; auth: Authenticator }): Router {
  const { chat, auth } = deps;
  const router = Router();
  router.use(auth.requireAuth);
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  router.get('/status', (_req, res) => res.json(chat.status()));

  router.get('/suggestions', ah(async (req, res) => {
    const jobId = uuidSchema.safeParse(req.query.jobId);
    if (!jobId.success) throw notFound('Test not found.');
    res.json({ suggestions: await chat.suggestions(currentUser(req).id, jobId.data) });
  }));

  router.get('/conversations', ah(async (req, res) => {
    const jobId = uuidSchema.safeParse(req.query.jobId);
    res.json({ items: await chat.listConversations(currentUser(req).id, jobId.success ? jobId.data : undefined) });
  }));

  router.post('/conversations', ah(async (req, res) => {
    const { jobId } = createSchema.parse(req.body ?? {});
    res.status(201).json({ conversation: await chat.createConversation(currentUser(req).id, jobId ?? null) });
  }));

  router.get('/conversations/:id', ah(async (req, res) => {
    res.json(await chat.getConversation(currentUser(req).id, String(req.params.id)));
  }));

  router.delete('/conversations/:id', ah(async (req, res) => {
    await chat.deleteConversation(currentUser(req).id, String(req.params.id));
    res.status(204).end();
  }));

  router.post('/conversations/:id/messages', ah(async (req, res) => {
    const { content } = messageSchema.parse(req.body);
    res.json(await chat.send(currentUser(req).id, String(req.params.id), content));
  }));

  return router;
}
