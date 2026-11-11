import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';

const base = { NODE_ENV: 'development', SUPABASE_DB_URL: 'postgresql://x@h/db', REDIS_URL: 'redis://h:6379', SUPABASE_JWT_SECRET: 'a'.repeat(40), AUTH_PROVIDER: 'local', SESSION_SECRET: 'b'.repeat(40) };

describe('config', () => {
  it('treats blank .env values as unset (as .env.example ships them)', () => {
    const c = loadConfig({ ...base, ADMIN_NOTIFICATION_EMAIL: '', RESEND_API_KEY: '', AI_API_KEY: '' });
    assert.equal(c.ADMIN_NOTIFICATION_EMAIL, undefined);
  });
  it('still rejects a malformed admin email', () => {
    assert.throws(() => loadConfig({ ...base, ADMIN_NOTIFICATION_EMAIL: 'not-an-email' }), /ADMIN_NOTIFICATION_EMAIL/);
  });
});
