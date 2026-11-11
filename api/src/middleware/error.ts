import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { HttpError } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';

export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json({ error: { code: 'not_found', message: 'Not found.' } });
};

/** Never leaks stack traces or internals to users; technical detail goes to the structured log only. */
export function createErrorHandler(logger: Logger): ErrorRequestHandler {
  return (err, req, res, _next) => {
    if (err instanceof HttpError) {
      const retry = (err as { retryAfterSec?: number }).retryAfterSec;
      if (retry) res.setHeader('Retry-After', String(retry));
      res.status(err.status).json({ error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } });
      return;
    }
    if (err instanceof ZodError) {
      const first = err.issues[0];
      res.status(400).json({ error: { code: 'validation_error', message: first?.message ?? 'Invalid request.', details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) } });
      return;
    }
    if ((err as { type?: string })?.type === 'entity.parse.failed') {
      res.status(400).json({ error: { code: 'bad_json', message: 'The request body is not valid JSON.' } });
      return;
    }
    if ((err as { type?: string })?.type === 'entity.too.large') {
      res.status(413).json({ error: { code: 'too_large', message: 'The request is too large.' } });
      return;
    }
    logger.error({ err: err instanceof Error ? { message: err.message, stack: err.stack } : String(err), path: req.path, method: req.method }, 'unhandled error');
    res.status(500).json({ error: { code: 'internal_error', message: 'Something went wrong on our side. Please try again.' } });
  };
}

/** Express 4 does not catch rejected promises; this wrapper forwards them to the error handler. */
export const ah =
  (fn: (...args: Parameters<RequestHandler>) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };
