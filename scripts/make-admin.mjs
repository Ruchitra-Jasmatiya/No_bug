// Gives an existing, signed-up account the admin role:  node --env-file=.env scripts/make-admin.mjs you@example.com
// Run it only for your own account. Admin access is checked on the server for every /api/admin request.
import pg from 'pg';

const email = (process.argv[2] ?? '').trim().toLowerCase();
if (!email.includes('@')) {
  console.error('Usage: node --env-file=.env scripts/make-admin.mjs you@example.com');
  process.exit(1);
}
const url = process.env.SUPABASE_DB_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error('Set SUPABASE_DB_URL (or DATABASE_URL) in .env first.');
  process.exit(1);
}
const pool = new pg.Pool({
  connectionString: url,
  ssl: /localhost|127\.0\.0\.1/.test(url) ? undefined : { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' },
});
try {
  const { rows } = await pool.query('select id from public.profiles where lower(email) = $1', [email]);
  if (!rows[0]) {
    console.error(`No account found for ${email}. Sign up on the website first, then run this again.`);
    process.exit(1);
  }
  await pool.query(`insert into public.user_roles (user_id, role) values ($1, 'admin') on conflict do nothing`, [rows[0].id]);
  console.log(`${email} is now an admin. Log out and back in, then open /admin.`);
} finally {
  await pool.end();
}
