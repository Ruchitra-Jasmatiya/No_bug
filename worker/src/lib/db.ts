import pg from 'pg';

/** Create a Postgres pool. Supabase connections require TLS. */
export function createPool(connectionString: string, max = 10): pg.Pool {
  const needsTls = /supabase\.(co|com)|pooler\./.test(connectionString) || /sslmode=require/.test(connectionString);
  return new pg.Pool({
    connectionString,
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl: needsTls ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' } : undefined,
  });
}