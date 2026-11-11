#!/usr/bin/env node
/**
 * Minimal, dependency-light migration runner.
 *   node scripts/migrate.mjs            apply supabase/migrations/*.sql to SUPABASE_DB_URL
 *   node scripts/migrate.mjs --local    first apply supabase/local/*.sql (auth stub for plain Postgres)
 * Each file is applied once, in order, inside a transaction, and recorded in public.schema_migrations.
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const local = process.argv.includes('--local');
const url = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;

if (!url) {
  console.error('Set SUPABASE_DB_URL (or DATABASE_URL) to a Postgres connection string.');
  process.exit(1);
}
if (!local && /localhost|127\.0\.0\.1/.test(url) === false && process.env.NODE_ENV === 'test') {
  console.error('Refusing to run non-local migrations from a test environment.');
  process.exit(1);
}

const client = new pg.Client({ connectionString: url, ssl: /supabase\.(co|com)|pooler\./.test(url) ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' } : undefined });
await client.connect();

async function applyDir(dir, tag) {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const name = `${tag}/${file}`;
    const done = await client.query('select 1 from public.schema_migrations where name = $1', [name]);
    if (done.rowCount) {
      console.log(`skip   ${name}`);
      continue;
    }
    const sql = await readFile(join(dir, file), 'utf8');
    try {
      await client.query('begin');
      await client.query(sql);
      await client.query('insert into public.schema_migrations (name) values ($1)', [name]);
      await client.query('commit');
      console.log(`apply  ${name}`);
    } catch (err) {
      await client.query('rollback');
      console.error(`FAILED ${name}: ${err.message}`);
      process.exitCode = 1;
      throw err;
    }
  }
}

try {
  await client.query('create table if not exists public.schema_migrations (name text primary key, applied_at timestamptz not null default now())');
  if (local) await applyDir(join(root, 'supabase', 'local'), 'local');
  await applyDir(join(root, 'supabase', 'migrations'), 'migrations');
  console.log('Migrations complete.');
} catch {
  /* error already reported */
} finally {
  await client.end();
}
