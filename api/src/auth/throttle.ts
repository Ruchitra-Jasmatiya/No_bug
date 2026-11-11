import type pg from 'pg';
import { tooMany } from '../lib/errors.js';
import { withRetry } from './otp.js';

/** Sliding-window counter backed by public.auth_attempts, used for unauthenticated endpoints. */
export class Throttle {
  constructor(private readonly pool: pg.Pool) {}

  /** Records an attempt and rejects with 429 when `limit` attempts already happened within the window. */
  async hit(kind: string, key: string, limit: number, windowMs: number, message: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query('select pg_advisory_xact_lock(hashtext($1))', [`throttle:${kind}:${key}`]);
      const r = await client.query<{ n: number; oldest_wait: number | null }>(
        `select count(*)::int as n,
                extract(epoch from (min(created_at) + make_interval(secs => $3::float8 / 1000) - now()))::float8 as oldest_wait
           from public.auth_attempts where kind = $1 and key = $2 and created_at > now() - make_interval(secs => $3::float8 / 1000)`,
        [kind, key, windowMs],
      );
      if ((r.rows[0]?.n ?? 0) >= limit) {
        await client.query('rollback');
        throw withRetry(tooMany(message), Math.max(1, Math.ceil(r.rows[0]?.oldest_wait ?? 60)));
      }
      await client.query('insert into public.auth_attempts (kind, key) values ($1,$2)', [kind, key]);
      await client.query('commit');
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}
