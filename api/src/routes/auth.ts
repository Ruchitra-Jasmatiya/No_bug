import type { CookieOptions, Request, Response } from 'express';
import { Router } from 'express';
import type pg from 'pg';
import { forgotPasswordSchema, loginSchema, resendOtpSchema, resetPasswordSchema, signupSchema, verifyOtpSchema } from '@nba/shared';
import type { AuthService } from '../auth/service.js';
import type { ClientContext } from '../auth/identity.js';
import { HttpError } from '../lib/errors.js';
import { ah } from '../middleware/error.js';
import { currentUser, type Authenticator } from '../middleware/auth.js';

export const REFRESH_COOKIE = 'nba_rt';
const CSRF_HEADER = 'x-requested-with';
const CSRF_VALUE = 'nba-web';

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      try {
        return decodeURIComponent(part.slice(idx + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

function ctxOf(req: Request): ClientContext {
  return { ip: req.ip ?? null, userAgent: (req.headers['user-agent'] as string | undefined) ?? null };
}

export function createAuthRouter(deps: { auth: AuthService; pool: pg.Pool; authn: Authenticator; production: boolean }): Router {
  const { auth, pool, authn, production } = deps;
  const router = Router();
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  // HttpOnly: JavaScript (and therefore XSS) cannot read it. SameSite=Lax + Secure in production.
  // Scoped to /api/auth so it is only ever sent to the endpoints that use it.
  const cookieOpts = (): CookieOptions => ({ httpOnly: true, secure: production, sameSite: 'lax', path: '/api/auth', maxAge: 30 * 24 * 3600 * 1000 });
  const setRefresh = (res: Response, token: string) => res.cookie(REFRESH_COOKIE, token, cookieOpts());
  const clearRefresh = (res: Response) => res.clearCookie(REFRESH_COOKIE, { ...cookieOpts(), maxAge: undefined });
  /** Cookie-authenticated endpoints additionally require a header a cross-site form post cannot send. */
  const requireCsrfHeader = (req: Request) => {
    if (req.get(CSRF_HEADER) !== CSRF_VALUE) throw new HttpError(403, 'csrf', 'Request rejected.');
  };

  router.post('/signup', ah(async (req, res) => {
    const input = signupSchema.parse(req.body);
    res.status(202).json(await auth.signup(input, ctxOf(req)));
  }));

  router.post('/verify-otp', ah(async (req, res) => {
    const { email, code, purpose } = verifyOtpSchema.parse(req.body);
    if (purpose !== 'signup') throw new HttpError(400, 'bad_request', 'Use the password reset form to confirm a reset code.');
    res.json(await auth.verifySignupOtp(email, code, ctxOf(req)));
  }));

  router.post('/resend-otp', ah(async (req, res) => {
    const { email, purpose } = resendOtpSchema.parse(req.body);
    res.status(202).json(await auth.resendOtp(email, purpose, ctxOf(req)));
  }));

  router.post('/login', ah(async (req, res) => {
    const { email, password } = loginSchema.parse(req.body);
    const { session, user } = await auth.login(email, password, ctxOf(req));
    setRefresh(res, session.refreshToken);
    res.json({ accessToken: session.accessToken, expiresIn: session.expiresIn, user });
  }));

  router.post('/refresh', ah(async (req, res) => {
    requireCsrfHeader(req);
    const token = readCookie(req, REFRESH_COOKIE);
    if (!token) throw new HttpError(401, 'unauthorized', 'Please sign in to continue.');
    try {
      const session = await auth.refresh(token, ctxOf(req));
      setRefresh(res, session.refreshToken);
      res.json({ accessToken: session.accessToken, expiresIn: session.expiresIn });
    } catch (err) {
      if (err instanceof HttpError && err.status === 401) clearRefresh(res);
      throw err;
    }
  }));

  router.post('/logout', ah(async (req, res) => {
    requireCsrfHeader(req);
    await auth.logout(readCookie(req, REFRESH_COOKIE));
    clearRefresh(res);
    res.status(204).end();
  }));

  router.post('/forgot-password', ah(async (req, res) => {
    const { email } = forgotPasswordSchema.parse(req.body);
    res.json(await auth.forgotPassword(email, ctxOf(req)));
  }));

  router.post('/reset-password', ah(async (req, res) => {
    const { email, code, newPassword } = resetPasswordSchema.parse(req.body);
    res.json(await auth.resetPassword({ email, code, newPassword }, ctxOf(req)));
  }));

  router.get('/me', authn.requireAuth, ah(async (req, res) => {
    const u = currentUser(req);
    const { rows } = await pool.query('select id, email, full_name, phone, created_at, last_login_at from public.profiles where id = $1', [u.id]);
    const p = rows[0];
    res.json({ user: { id: p.id, email: p.email, fullName: p.full_name, phone: p.phone, role: u.role, emailVerified: true, createdAt: p.created_at, lastLoginAt: p.last_login_at } });
  }));

  return router;
}
