import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type pg from 'pg';
import type { ApiConfig } from '../config.js';
import { forbidden, unauthorized } from '../lib/errors.js';

export interface AuthUser {
  id: string;
  email: string;
  role: 'user' | 'admin';
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthUser;
  }
}

export interface Authenticator {
  requireAuth: RequestHandler;
  requireAdmin: RequestHandler;
}

/**
 * Verifies the Supabase access token (signature, expiry, audience) and then loads the account from OUR
 * database: suspension and the admin role are always decided server-side, never from token claims.
 */
export function createAuthenticator(config: Pick<ApiConfig, 'SUPABASE_URL' | 'SUPABASE_JWT_SECRET'>, pool: pg.Pool): Authenticator {
  const secret = config.SUPABASE_JWT_SECRET ? new TextEncoder().encode(config.SUPABASE_JWT_SECRET) : null;
  const jwks: JWTVerifyGetKey | null = config.SUPABASE_URL ? createRemoteJWKSet(new URL('/auth/v1/.well-known/jwks.json', config.SUPABASE_URL)) : null;
  const issuer = config.SUPABASE_URL ? new URL('/auth/v1', config.SUPABASE_URL).toString().replace(/\/$/, '') : undefined;

  async function verify(token: string): Promise<string> {
    const opts = { audience: 'authenticated', ...(issuer ? { issuer } : {}) };
    // Algorithms are pinned per key type, so an attacker cannot downgrade to "none" or confuse HS/RS keys.
    const { payload } = secret
      ? await jwtVerify(token, secret, { ...opts, algorithms: ['HS256'] })
      : await jwtVerify(token, jwks!, { ...opts, algorithms: ['RS256', 'ES256', 'EdDSA'] });
    if (!payload.sub) throw new Error('missing subject');
    return payload.sub;
  }

  const requireAuth: RequestHandler = async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const header = req.headers.authorization ?? '';
      const match = /^Bearer\s+(.+)$/i.exec(header);
      if (!match) throw unauthorized();
      let userId: string;
      try {
        userId = await verify(match[1]!);
      } catch {
        throw unauthorized('Your session has expired. Please sign in again.');
      }
      const { rows } = await pool.query<{ email: string; account_status: string; is_admin: boolean }>(
        `select p.email, p.account_status,
                exists (select 1 from public.user_roles r where r.user_id = p.id and r.role = 'admin') as is_admin
           from public.profiles p where p.id = $1`,
        [userId],
      );
      const profile = rows[0];
      if (!profile) throw unauthorized('Account not found. Please sign in again.');
      if (profile.account_status !== 'active') throw forbidden('This account has been suspended. Please contact support.');
      req.user = { id: userId, email: profile.email, role: profile.is_admin ? 'admin' : 'user' };
      next();
    } catch (err) {
      next(err);
    }
  };

  const requireAdmin: RequestHandler = (req, res, next) => {
    requireAuth(req, res, (err?: unknown) => {
      if (err) return next(err);
      if (req.user?.role !== 'admin') return next(forbidden());
      next();
    });
  };

  return { requireAuth, requireAdmin };
}

export function currentUser(req: Request): AuthUser {
  if (!req.user) throw unauthorized();
  return req.user;
}
