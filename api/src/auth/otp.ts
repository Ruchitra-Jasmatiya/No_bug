import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import type pg from 'pg';
import type { OtpPurpose } from '@nba/shared';
import { tooMany } from '../lib/errors.js';

export interface OtpOptions {
  ttlMs: number;
  cooldownMs: number;
  maxAttempts: number;
  maxPerHour: number;
}
export const DEFAULT_OTP_OPTIONS: OtpOptions = { ttlMs: 10 * 60_000, cooldownMs: 60_000, maxAttempts: 5, maxPerHour: 6 };

export type OtpVerifyResult = { ok: true } | { ok: false; reason: 'invalid' | 'expired' | 'locked' | 'none'; attemptsLeft?: number };

/**
 * One-time codes: cryptographically random, stored only as HMAC-SHA256 (keyed with a server secret, so a database leak
 * does not let anyone brute-force the 10^6 code space offline), short-lived, single-use, attempt-limited and
 * rate-limited per address.
 */
export class OtpService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly pepper: string,
    private readonly opts: OtpOptions = DEFAULT_OTP_OPTIONS,
  ) {}

  get ttlMinutes(): number {
    return Math.round(this.opts.ttlMs / 60_000);
  }

  private hash(email: string, purpose: OtpPurpose, code: string): Buffer {
    return createHmac('sha256', this.pepper).update(`${purpose}\u0000${email}\u0000${code}`).digest();
  }

  /** Issue a fresh code. Throws a 429 (with retry-after) during the cooldown or when the hourly cap is reached. */
  async issue(email: string, purpose: OtpPurpose, ip: string | null): Promise<{ code: string }> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query('select pg_advisory_xact_lock(hashtext($1))', [`otp:${purpose}:${email}`]);

      const latest = await client.query<{ wait: number | null }>(
        `select extract(epoch from (created_at + make_interval(secs => $3::float8 / 1000) - now()))::float8 as wait
           from public.otp_codes where lower(email) = $1 and purpose = $2 order by created_at desc limit 1`,
        [email, purpose, this.opts.cooldownMs],
      );
      const wait = latest.rows[0]?.wait ?? 0;
      if (wait > 0) throw withRetry(tooMany(`Please wait ${Math.ceil(wait)} seconds before requesting another code.`), Math.ceil(wait));

      const hourly = await client.query<{ n: number }>(
        `select count(*)::int as n from public.otp_codes where lower(email) = $1 and purpose = $2 and created_at > now() - interval '1 hour'`,
        [email, purpose],
      );
      if ((hourly.rows[0]?.n ?? 0) >= this.opts.maxPerHour) {
        throw withRetry(tooMany('Too many codes requested. Please try again in a little while.'), 600);
      }

      // A new code replaces any earlier one: older codes can no longer be used.
      await client.query(`update public.otp_codes set consumed_at = now() where lower(email) = $1 and purpose = $2 and consumed_at is null`, [email, purpose]);

      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      await client.query(
        `insert into public.otp_codes (email, purpose, code_hash, expires_at, max_attempts, ip)
         values ($1,$2,$3, now() + make_interval(secs => $4::float8 / 1000), $5, $6)`,
        [email, purpose, this.hash(email, purpose, code).toString('hex'), this.opts.ttlMs, this.opts.maxAttempts, ip],
      );
      await client.query('commit');
      return { code };
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** Verify and consume. Wrong guesses are counted atomically; the code dies after max attempts. */
  async verify(email: string, purpose: OtpPurpose, code: string): Promise<OtpVerifyResult> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const found = await client.query<{ id: string; code_hash: string; attempts: number; max_attempts: number; expired: boolean }>(
        `select id, code_hash, attempts, max_attempts, (expires_at < now()) as expired
           from public.otp_codes where lower(email) = $1 and purpose = $2 and consumed_at is null
          order by created_at desc limit 1 for update`,
        [email, purpose],
      );
      const row = found.rows[0];
      if (!row) {
        await client.query('commit');
        return { ok: false, reason: 'none' };
      }
      if (row.expired) {
        await client.query('update public.otp_codes set consumed_at = now() where id = $1', [row.id]);
        await client.query('commit');
        return { ok: false, reason: 'expired' };
      }
      if (row.attempts >= row.max_attempts) {
        await client.query('update public.otp_codes set consumed_at = now() where id = $1', [row.id]);
        await client.query('commit');
        return { ok: false, reason: 'locked' };
      }

      const expected = Buffer.from(row.code_hash, 'hex');
      const actual = this.hash(email, purpose, code);
      if (expected.length === actual.length && timingSafeEqual(expected, actual)) {
        await client.query('update public.otp_codes set consumed_at = now() where id = $1', [row.id]);
        await client.query('commit');
        return { ok: true };
      }

      const attempts = row.attempts + 1;
      const dead = attempts >= row.max_attempts;
      await client.query('update public.otp_codes set attempts = $2, consumed_at = case when $3 then now() else consumed_at end where id = $1', [row.id, attempts, dead]);
      await client.query('commit');
      return dead ? { ok: false, reason: 'locked' } : { ok: false, reason: 'invalid', attemptsLeft: row.max_attempts - attempts };
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}

export function withRetry<T extends Error>(err: T, seconds: number): T & { retryAfterSec: number } {
  return Object.assign(err, { retryAfterSec: seconds });
}
