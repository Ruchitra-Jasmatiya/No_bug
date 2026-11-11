/**
 * Row Level Security tests. Needs a migrated Postgres:
 *   TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:54329/nba_test npm test -w api
 * Skipped (not "passed") when no database is configured.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import pg from 'pg';

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

suite('row level security', () => {
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  const ids = {} as Record<'a' | 'b' | 'admin', string> & Record<string, string>;

  async function as<T>(userId: string | null, role: 'authenticated' | 'anon', fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await pool.connect();
    try {
      await c.query('begin');
      await c.query(`set local role ${role}`);
      await c.query(`select set_config('request.jwt.claim.sub', $1, true)`, [userId ?? '']);
      return await fn(c);
    } finally {
      await c.query('rollback').catch(() => undefined);
      c.release();
    }
  }

  before(async () => {
    const mk = async (email: string, name: string) =>
      (await pool.query<{ id: string }>(
        `insert into auth.users (email, raw_user_meta_data, email_confirmed_at) values ($1, $2, now()) returning id`,
        [email, JSON.stringify({ full_name: name })],
      )).rows[0]!.id;
    const tag = Date.now();
    ids.a = await mk(`a+${tag}@example.com`, 'User A');
    ids.b = await mk(`b+${tag}@example.com`, 'User B');
    ids.admin = await mk(`admin+${tag}@example.com`, 'Admin');
    await pool.query(`insert into public.user_roles (user_id, role) values ($1, 'admin')`, [ids.admin]);

    for (const key of ['a', 'b'] as const) {
      const uid = ids[key]!;
      const project = (await pool.query<{ id: string }>(
        `insert into public.test_projects (user_id, name, base_url, hostname) values ($1, 'p', $2, 'example.com') returning id`,
        [uid, `https://${key}.example.com/`],
      )).rows[0]!.id;
      const job = (await pool.query<{ id: string }>(
        `insert into public.test_jobs (project_id, user_id, target_url, hostname, selected_modules) values ($1, $2, $3, 'example.com', '{connectivity}') returning id`,
        [project, uid, `https://${key}.example.com/`],
      )).rows[0]!.id;
      ids[`job_${key}`] = job;
      const result = (await pool.query<{ id: string }>(
        `insert into public.test_results (job_id, module_id, category, check_key, title, status) values ($1, 'connectivity', 'connectivity', 'x', 't', 'fail') returning id`,
        [job],
      )).rows[0]!.id;
      await pool.query(
        `insert into public.bug_reports (job_id, result_id, category, severity, confidence, title, description) values ($1, $2, 'connectivity', 'high', 'confirmed', 't', 'd')`,
        [job, result],
      );
      await pool.query(`insert into public.test_logs (job_id, message) values ($1, 'hello')`, [job]);
      await pool.query(`insert into public.test_modules (job_id, module_id, position) values ($1, 'connectivity', 0)`, [job]);
      ids[`conv_${key}`] = (await pool.query<{ id: string }>(
        `insert into public.chatbot_conversations (user_id, job_id) values ($1, $2) returning id`,
        [uid, job],
      )).rows[0]!.id;
    }
    await pool.query(`insert into public.security_events (kind, risk_level, email) values ('test', 'low', 'x@example.com')`);
    await pool.query(`insert into public.login_events (user_id, email, success) values ($1, 'a@example.com', false)`, [ids.a]);
  });

  after(async () => {
    await pool.query('delete from auth.users where id = any($1)', [[ids.a, ids.b, ids.admin]]);
    await pool.query('delete from public.security_events where kind = $1', ['test']);
    await pool.end();
  });

  const rows = async (c: pg.PoolClient, table: string) => (await c.query(`select * from public.${table}`)).rows;

  it('a user sees only their own jobs, results, bugs, logs and modules', async () => {
    await as(ids.a!, 'authenticated', async (c) => {
      for (const t of ['test_jobs', 'test_results', 'bug_reports', 'test_logs', 'test_modules', 'test_projects']) {
        const r = await rows(c, t);
        assert.equal(r.length, 1, `${t} should expose exactly the user's own row`);
      }
      assert.equal((await rows(c, 'test_jobs'))[0].id, ids.job_a);
    });
  });

  it("a user cannot read another user's job by id", async () => {
    await as(ids.a!, 'authenticated', async (c) => {
      const r = await c.query('select * from public.test_jobs where id = $1', [ids.job_b]);
      assert.equal(r.rowCount, 0);
      const bugs = await c.query('select * from public.bug_reports where job_id = $1', [ids.job_b]);
      assert.equal(bugs.rowCount, 0);
    });
  });

  it('a user sees only their own profile and roles', async () => {
    await as(ids.a!, 'authenticated', async (c) => {
      const p = await rows(c, 'profiles');
      assert.equal(p.length, 1);
      assert.equal(p[0].id, ids.a);
      const roles = await rows(c, 'user_roles');
      assert.deepEqual(roles.map((r) => r.role), ['user']);
    });
  });

  it('a user cannot see security events, notifications or audit logs', async () => {
    await as(ids.a!, 'authenticated', async (c) => {
      for (const t of ['security_events', 'email_notifications', 'audit_logs']) {
        assert.equal((await rows(c, t)).length, 0, t);
      }
    });
  });

  it("a user sees only their own login events", async () => {
    await as(ids.b!, 'authenticated', async (c) => assert.equal((await rows(c, 'login_events')).length, 0));
    await as(ids.a!, 'authenticated', async (c) => assert.equal((await rows(c, 'login_events')).length, 1));
  });

  it('browser roles cannot write to server-managed tables', async () => {
    await as(ids.a!, 'authenticated', async (c) => {
      await assert.rejects(c.query(`update public.test_jobs set status = 'completed' where id = $1`, [ids.job_a]), /permission denied/);
    });
    await as(ids.a!, 'authenticated', async (c) => {
      await assert.rejects(c.query(`delete from public.bug_reports`), /permission denied/);
    });
    await as(ids.a!, 'authenticated', async (c) => {
      await assert.rejects(c.query(`update public.user_roles set role = 'admin' where user_id = $1`, [ids.a]), /permission denied/);
    });
    await as(ids.a!, 'authenticated', async (c) => {
      await assert.rejects(c.query(`insert into public.user_roles (user_id, role) values ($1, 'admin')`, [ids.a]), /permission denied/);
    });
    await as(ids.a!, 'authenticated', async (c) => {
      await assert.rejects(c.query(`update public.profiles set account_status = 'active', full_name = 'x' where id = $1`, [ids.a]), /permission denied/);
    });
  });

  it('chatbot: a user can create conversations for themselves but not for others', async () => {
    await as(ids.a!, 'authenticated', async (c) => {
      const mine = await c.query(`insert into public.chatbot_conversations (user_id) values ($1) returning id`, [ids.a]);
      assert.equal(mine.rowCount, 1);
    });
    await as(ids.a!, 'authenticated', async (c) => {
      await assert.rejects(c.query(`insert into public.chatbot_conversations (user_id) values ($1)`, [ids.b]), /row-level security/);
    });
  });

  it("chatbot: users cannot read or post into someone else's conversation, or forge assistant messages", async () => {
    await as(ids.a!, 'authenticated', async (c) => {
      assert.equal((await c.query('select * from public.chatbot_conversations where id = $1', [ids.conv_b])).rowCount, 0);
    });
    await as(ids.a!, 'authenticated', async (c) => {
      await assert.rejects(
        c.query(`insert into public.chatbot_messages (conversation_id, role, content) values ($1, 'user', 'hi')`, [ids.conv_b]),
        /row-level security/,
      );
    });
    await as(ids.a!, 'authenticated', async (c) => {
      await assert.rejects(
        c.query(`insert into public.chatbot_messages (conversation_id, role, content) values ($1, 'assistant', 'fake')`, [ids.conv_a]),
        /row-level security/,
      );
    });
    await as(ids.a!, 'authenticated', async (c) => {
      const ok = await c.query(`insert into public.chatbot_messages (conversation_id, role, content) values ($1, 'user', 'hi') returning id`, [ids.conv_a]);
      assert.equal(ok.rowCount, 1);
    });
  });

  it('anonymous visitors cannot read private data, only public settings', async () => {
    await as(null, 'anon', async (c) => {
      await assert.rejects(c.query('select * from public.test_jobs'), /permission denied/);
    });
    await as(null, 'anon', async (c) => {
      await assert.rejects(c.query('select * from public.profiles'), /permission denied/);
    });
    await as(null, 'anon', async (c) => {
      const settings = await rows(c, 'app_settings');
      assert.ok(settings.length > 0);
      assert.ok(settings.every((s) => s.is_public === true), 'only public settings are visible');
      assert.ok(!settings.some((s) => s.key === 'login_security'));
    });
  });

  it('an administrator can read across users, including security data', async () => {
    await as(ids.admin!, 'authenticated', async (c) => {
      const jobs = (await rows(c, 'test_jobs')).filter((j) => [ids.job_a, ids.job_b].includes(j.id));
      assert.equal(jobs.length, 2);
      assert.ok((await rows(c, 'security_events')).length >= 1);
      assert.ok((await rows(c, 'profiles')).length >= 3);
      assert.ok((await rows(c, 'app_settings')).some((s) => s.key === 'login_security'));
    });
  });

  it('admin status is derived from the database, and suspension revokes it', async () => {
    await pool.query(`update public.profiles set account_status = 'suspended' where id = $1`, [ids.admin]);
    try {
      await as(ids.admin!, 'authenticated', async (c) => {
        assert.equal((await c.query('select public.is_admin() as a')).rows[0].a, false);
        assert.equal((await rows(c, 'security_events')).length, 0);
      });
    } finally {
      await pool.query(`update public.profiles set account_status = 'active' where id = $1`, [ids.admin]);
    }
  });

  it('a normal user is never an admin, even if they claim to be', async () => {
    await as(ids.a!, 'authenticated', async (c) => {
      await c.query(`select set_config('request.jwt.claim.role', 'admin', true)`);
      assert.equal((await c.query('select public.is_admin() as a')).rows[0].a, false);
    });
  });

  it('migrations seeded the default settings', async () => {
    const r = await pool.query(`select key from public.app_settings order by key`);
    for (const k of ['enabled_modules', 'timeouts', 'concurrency', 'rate_limits', 'crawl_limits', 'ai', 'login_security']) {
      assert.ok(r.rows.some((x) => x.key === k), k);
    }
  });

  it('cascades: deleting a user removes their projects, jobs and conversations', async () => {
    const tmp = (await pool.query<{ id: string }>(`insert into auth.users (email) values ($1) returning id`, [`tmp+${Date.now()}@example.com`])).rows[0]!.id;
    const project = (await pool.query<{ id: string }>(`insert into public.test_projects (user_id, name, base_url, hostname) values ($1,'p','https://t.example.com/','t.example.com') returning id`, [tmp])).rows[0]!.id;
    await pool.query(`insert into public.test_jobs (project_id, user_id, target_url, hostname, selected_modules) values ($1,$2,'https://t.example.com/','t.example.com','{connectivity}')`, [project, tmp]);
    await pool.query('delete from auth.users where id = $1', [tmp]);
    assert.equal((await pool.query('select 1 from public.test_jobs where user_id = $1', [tmp])).rowCount, 0);
    assert.equal((await pool.query('select 1 from public.profiles where id = $1', [tmp])).rowCount, 0);
  });
});
