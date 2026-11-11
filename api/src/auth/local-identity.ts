import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { SignJWT } from 'jose';
import type pg from 'pg';
import { type ClientContext, EmailExistsError, type IdentityProvider, type Session, type SignInResult } from './identity.js';

const N = 16_384;
const R = 8;
const P = 1;
const KEYLEN = 64;

function scryptAsync(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, salt, KEYLEN, { N: n, r, p, maxmem: 64 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key))));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password.normalize('NFKC'), salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, key] = stored.split('$');
  if (scheme !== 'scrypt' || !n || !r || !p || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64');
  const actual = await scryptAsync(password.normalize('NFKC'), Buffer.from(salt, 'base64'), Number(n), Number(r), Number(p));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const REFRESH_TTL_SEC = 30 * 24 * 3600;
/** A refresh token replaced within this window is treated as a harmless double-submit, not theft. */
const REUSE_GRACE_SEC = 10;
let DUMMY_HASH: Promise<string> | null = null;

export interface LocalIdentityOptions {
  jwtSecret: string;
  issuer?: string;
  accessTtlSec?: number;
}

/** Development / test identity provider. Refused by the server when NODE_ENV=production. */
export class LocalIdentity implements IdentityProvider {
  readonly name = 'local' as const;
  private readonly key: Uint8Array;
  private readonly accessTtl: number;

  constructor(
    private readonly pool: pg.Pool,
    private readonly opts: LocalIdentityOptions,
  ) {
    this.key = new TextEncoder().encode(opts.jwtSecret);
    this.accessTtl = opts.accessTtlSec ?? 900;
  }

  async createUser(input: { email: string; password: string; fullName: string; phone?: string }): Promise<{ id: string }> {
    const hash = await hashPassword(input.password);
    try {
      const r = await this.pool.query<{ id: string }>(
        `insert into auth.users (email, raw_user_meta_data, encrypted_password) values ($1,$2,$3) returning id`,
        [input.email, JSON.stringify({ full_name: input.fullName, phone: input.phone ?? '' }), hash],
      );
      return { id: r.rows[0]!.id };
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new EmailExistsError();
      throw err;
    }
  }

  async updatePendingUser(id: string, input: { password: string; fullName: string; phone?: string }): Promise<void> {
    const hash = await hashPassword(input.password);
    await this.pool.query(`update auth.users set encrypted_password = $2, raw_user_meta_data = $3 where id = $1 and email_confirmed_at is null`, [
      id,
      hash,
      JSON.stringify({ full_name: input.fullName, phone: input.phone ?? '' }),
    ]);
  }

  async markEmailVerified(id: string): Promise<void> {
    await this.pool.query('update auth.users set email_confirmed_at = coalesce(email_confirmed_at, now()) where id = $1', [id]);
  }

  async signIn(email: string, password: string, ctx: ClientContext): Promise<SignInResult> {
    const { rows } = await this.pool.query<{ id: string; encrypted_password: string | null; email_confirmed_at: Date | null }>(
      'select id, encrypted_password, email_confirmed_at from auth.users where lower(email) = $1',
      [email],
    );
    const user = rows[0];
    if (!user || !user.encrypted_password) {
      // Spend the same time as a real check so response timing does not reveal which emails exist.
      DUMMY_HASH ??= hashPassword('dummy-password-for-timing');
      await verifyPassword(password, await DUMMY_HASH);
      return { kind: 'bad_credentials' };
    }
    if (!(await verifyPassword(password, user.encrypted_password))) return { kind: 'bad_credentials' };
    if (!user.email_confirmed_at) return { kind: 'unverified' };
    return { kind: 'ok', session: await this.issue(user.id, randomUUID(), ctx) };
  }

  private async issue(userId: string, familyId: string, ctx: ClientContext): Promise<Session> {
    const email = (await this.pool.query<{ email: string }>('select email from auth.users where id = $1', [userId])).rows[0]?.email ?? '';
    const accessToken = await new SignJWT({ role: 'authenticated', email })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(userId)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime(`${this.accessTtl}s`)
      .setIssuer(this.opts.issuer ?? 'nba-local')
      .sign(this.key);
    const refreshToken = randomBytes(32).toString('base64url');
    await this.pool.query(
      `insert into public.local_refresh_tokens (user_id, family_id, token_hash, expires_at, ip, user_agent)
       values ($1,$2,$3, now() + make_interval(secs => $4), $5, $6)`,
      [userId, familyId, sha256(refreshToken), REFRESH_TTL_SEC, ctx.ip, ctx.userAgent?.slice(0, 300) ?? null],
    );
    return { accessToken, refreshToken, expiresIn: this.accessTtl, userId };
  }

  async refresh(refreshToken: string, ctx: ClientContext): Promise<Session | null> {
    const hash = sha256(refreshToken);
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const found = await client.query<{ id: string; user_id: string; family_id: string; expired: boolean; revoked_at: Date | null; since_revoked: number | null }>(
        `select id, user_id, family_id, (expires_at < now()) as expired, revoked_at,
                extract(epoch from (now() - revoked_at))::float8 as since_revoked
           from public.local_refresh_tokens where token_hash = $1 for update`,
        [hash],
      );
      const row = found.rows[0];
      if (!row) {
        await client.query('commit');
        return null;
      }
      if (row.revoked_at) {
        // Reuse of an already-rotated token outside the grace window means it may have been stolen: kill the family.
        if ((row.since_revoked ?? 0) > REUSE_GRACE_SEC) {
          await client.query('update public.local_refresh_tokens set revoked_at = coalesce(revoked_at, now()) where family_id = $1', [row.family_id]);
        }
        await client.query('commit');
        return null;
      }
      if (row.expired) {
        await client.query('commit');
        return null;
      }
      await client.query('update public.local_refresh_tokens set revoked_at = now() where id = $1', [row.id]);
      await client.query('commit');
      return await this.issue(row.user_id, row.family_id, ctx);
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async revoke(refreshToken: string): Promise<void> {
    await this.pool.query(
      `update public.local_refresh_tokens set revoked_at = coalesce(revoked_at, now())
        where family_id = (select family_id from public.local_refresh_tokens where token_hash = $1)`,
      [sha256(refreshToken)],
    );
  }

  async revokeAllSessions(userId: string): Promise<void> {
    await this.pool.query('update public.local_refresh_tokens set revoked_at = coalesce(revoked_at, now()) where user_id = $1', [userId]);
  }

  async setPassword(userId: string, newPassword: string): Promise<void> {
    await this.pool.query('update auth.users set encrypted_password = $2 where id = $1', [userId, await hashPassword(newPassword)]);
  }
}
