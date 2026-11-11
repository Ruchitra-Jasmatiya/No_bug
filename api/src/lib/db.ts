import pg from 'pg';

export function createPool(connectionString: string, max = 10): pg.Pool {
  const needsTls = /supabase\.(co|com)|pooler\./.test(connectionString) || /sslmode=require/.test(connectionString);
  return new pg.Pool({
    connectionString,
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl: needsTls ? { rejectUnauthorized: true } : undefined,
  });
}
