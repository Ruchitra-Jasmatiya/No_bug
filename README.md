# NO BUGS ALLOWED

> Find the bugs. Fix the problems. Launch with confidence.

An AI-assisted website testing platform: submit a URL, a background worker drives a real browser against it,
and you get a report with evidence, severity and recommended fixes. The assistant is called **BUGSY**.

**State: all phases built and verified locally. See [STATUS.md](STATUS.md) for exactly what was verified and what was not (real Supabase, Resend, Upstash and Anthropic could not be tested here).**

## Architecture

```
 Browser (Vercel)         API (Express)            Redis / BullMQ          Worker (Playwright)
 ───────────────  HTTPS   ───────────────  job id  ───────────────  pull   ────────────────────
 React + Vite  ─────────▶ validate, auth,  ───────▶ queue: nba-test-jobs ─▶ claim job in Postgres
                SSRF-check URL,                                    run modules in order,
                          write job row                                      checkpoint each one
                                │                                            heartbeat every 5s
                                ▼                                                   │
                       Supabase PostgreSQL  ◀───────────── results, logs, progress ─┘
                       (source of truth, RLS)
```

- **The database is the source of truth.** A job's state, module checkpoints, results and logs live in PostgreSQL.
  Redis only carries "please run job X"; if Redis is wiped, the worker's reaper re-enqueues from the database.
- **Recovery:** each module's outcome is saved in one transaction. After a crash another worker claims the job
  once its heartbeat is stale and runs only the unfinished modules. Completed modules are never rerun.
- **Honesty rules enforced in code:** a skipped or blocked module is never counted as a pass; a run is flagged
  *incomplete* when modules were skipped; the report says *"No issues detected in the tests performed."* and never
  claims a site is bug-free.
- **Browser isolation:** Chromium is launched through a local guarded proxy that resolves and validates every
  destination at connection time (this defeats DNS rebinding), allows only ports 80/443/8080/8443, grants no
  permissions (camera, microphone, location, clipboard), blocks service workers and downloads.

Folder layout: `shared/` (types, schemas, SSRF library) · `api/` (Express) · `worker/` (Playwright engine) ·
`supabase/` (migrations) · `scripts/` (migration runner) · `e2e/` (full-system + real-browser tests) · `web/` (React + Vite).

## Quick start (local)

Requirements: Node 22+, Docker (for Redis), a PostgreSQL database (Supabase or local), Chrome/Chromium.

```bash
# 1. install
npm install
npx playwright install chromium          # or set CHROME_EXECUTABLE_PATH to a system Chrome

# 2. configure
cp .env.example .env                     # then edit .env (see "Environment variables")

# 3. Redis
docker compose up -d redis

# 4. database (see "Database" below), then:
npm run db:migrate

# 5. run
npm run dev:api                          # http://localhost:4000/healthz
npm run dev:worker                       # in a second terminal
npm run dev:web                          # http://localhost:5173 (proxies /api to :4000)

# 6. verify
npm run typecheck && npm test
```

Or run everything in containers: `docker compose up --build` (API on :4000, worker, Redis).

## Database

**Supabase (production and recommended for development)**
1. Create a project at https://supabase.com.
2. Project Settings → Database → copy the connection string into `SUPABASE_DB_URL`.
3. Project Settings → API → copy the project URL into `SUPABASE_URL`.
4. `npm run db:migrate` applies `supabase/migrations/*.sql` in order (idempotent; recorded in `schema_migrations`).
5. Grant yourself admin (once, in the SQL editor):
   `insert into public.user_roles (user_id, role) values ('<your auth.users id>', 'admin');`

**Plain local PostgreSQL (no Supabase)**: `SUPABASE_DB_URL=postgresql://postgres@localhost:5432/nba npm run db:migrate:local`
first applies `supabase/local/00_auth_stub.sql`, which recreates the minimal `auth` schema and roles. Never run
that file against Supabase.

## Environment variables

See [.env.example](.env.example). Secrets (`SUPABASE_DB_URL`, `SUPABASE_JWT_SECRET`, `REDIS_URL`, and later
`RESEND_API_KEY` / `AI_API_KEY`) are server-side only. Browser variables must start with `VITE_` and are
public — never put a secret in one. `ADMIN_NOTIFICATION_EMAIL` is never hardcoded.

## Authentication

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/auth/signup` | `{ fullName, email, phone?, password, confirmPassword, termsAccepted: true }` → 202, emails a 6-digit code |
| POST | `/api/auth/verify-otp` | `{ email, code }` → marks the email verified (the account cannot sign in before this) |
| POST | `/api/auth/resend-otp` | `{ email, purpose? }` (60 s cooldown, 6 codes/hour) |
| POST | `/api/auth/login` | `{ email, password }` → `{ accessToken, user }` + HttpOnly refresh cookie |
| POST | `/api/auth/refresh` | rotates the refresh cookie (needs header `X-Requested-With: nba-web`) |
| POST | `/api/auth/logout` | revokes the session, clears the cookie |
| POST | `/api/auth/forgot-password` | `{ email }` → always the same response (no account enumeration) |
| POST | `/api/auth/reset-password` | `{ email, code, newPassword, confirmPassword }` → signs out every other session |
| GET | `/api/auth/me` | the signed-in user |

Security properties (all covered by tests): codes are random, stored only as a keyed hash, expire in 10 minutes, work once,
die after 5 wrong guesses, and are rate-limited; wrong-password and unknown-email responses are identical; failed sign-ins
trigger progressive delays (5 s doubling up to 15 min) that expire by themselves, never a permanent lock; refresh tokens rotate and
a replayed old token revokes the whole session; the refresh token is HttpOnly + SameSite=Lax and never appears in a response body;
suspended accounts cannot sign in or refresh. Production uses **Supabase Auth**; the `local` provider exists for development/tests and is refused in production.

**One-time setup:** create a Resend account, verify a sending domain, and put `RESEND_API_KEY` and `EMAIL_FROM` in `.env`. Without
them the API cannot send codes (it fails loudly; it never silently drops or logs a code).

## Web app

React + Vite + TypeScript, flat cream / sage / soft-yellow design (no gradients), Framer Motion animations that respect
`prefers-reduced-motion`. The access token lives in memory only; the session is restored from an HttpOnly refresh cookie.
**Deploy to Vercel:** import the repo (root directory = repo root; `web/vercel.json` is picked up), then edit the `/api` rewrite in
`web/vercel.json` to your API domain. Because `/api` is proxied, cookies stay same-origin and no `VITE_` variable is needed.

## Auth, email and security monitoring

- Sign-up sends a 6-digit OTP (stored only as an HMAC, 10 min expiry, single use, 5 attempts, resend cooldown). Needs `RESEND_API_KEY`, `EMAIL_FROM`, `SESSION_SECRET`.
- More than 10 failed logins in 15 minutes (configurable in admin settings) creates a security event and emails `ADMIN_NOTIFICATION_EMAIL` (once per subject per window). The address is read only from that variable.
- Grant the first admin once in SQL (see Database), then manage roles in the Admin console.

## AI / BUGSY

Set `AI_API_KEY` (and optionally `AI_PROVIDER`, `AI_MODEL`) on **both** the API and the worker. Without it everything works and the UI says AI is off.
Site-controlled text is sent only inside delimited, sanitised, secret-redacted blocks, and AI output can never change evidence, severity or status.

## API

All `/api/tests*` routes require `Authorization: Bearer <Supabase access token>`.

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/tests` | Create a test `{ url, authorizationConfirmed: true, modules?, idempotencyKey? }` → 202 |
| GET | `/api/tests` | List my tests (`page`, `pageSize`) |
| GET | `/api/tests/active` | My unfinished tests (restore a session after refresh / reopening the browser) |
| GET | `/api/tests/:id` | One test |
| GET | `/api/tests/:id/progress?after=<logCursor>` | Real progress: job, per-module state, counts, new logs |
| POST | `/api/tests/:id/resume` | Make a failed test runnable again from its checkpoints |
| POST | `/api/tests/:id/restart` | New test for the same URL; the old active one is cancelled |
| POST | `/api/tests/:id/cancel` | Cancel (immediate if queued, at next heartbeat if running) |
| GET | `/api/tests/:id/report` | Full report (409 until finished) |
| GET | `/api/tests/:id/bugs?severity=&category=` | Bug reports |
| GET | `/api/modules` | Which modules exist, are implemented and are enabled |
| GET | `/healthz` | Database and Redis health |
| * | `/api/auth/*` | signup, verify-otp, resend-otp, login, refresh, logout, forgot/reset-password, me |
| * | `/api/chat/*` | BUGSY status, conversations, messages |
| * | `/api/admin/*` | overview, analytics, system, users, tests, security, audit-logs, emails, settings (admin only) |

## Deploying

**Worker → Railway or Render** (never Vercel — browser tests are long-running)
1. Create a service from this repo using `worker/Dockerfile` (build context = repository root).
2. Set `SUPABASE_DB_URL`, `REDIS_URL` (Upstash `rediss://…`), `NODE_ENV=production`, `PORT` (Render needs one; `/healthz`).
3. Give it ≥ 2 GB RAM. Scale by adding instances: jobs are claimed atomically, so workers never double-run a job.
4. **Network isolation (important):** the worker runs untrusted websites in a browser. Apply an egress firewall that
   blocks private ranges and your cloud metadata service. The application layer already blocks them, but defence in
   depth is part of the design. Never give the worker credentials beyond the database URL and Redis URL.

**API → Railway/Render** using `api/Dockerfile`: `SUPABASE_DB_URL`, `REDIS_URL`, `SUPABASE_URL`, `CORS_ORIGINS=https://<your-vercel-domain>`, `TRUST_PROXY=1`.


## Testing

```bash
npm test                                   # shared + api + worker (DB-backed suites skip without TEST_DATABASE_URL)
TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/nba_test npm test    # include RLS, API and worker end-to-end
npm run build -w web
TEST_DATABASE_URL=... TEST_REDIS_URL=redis://127.0.0.1:6379 CHROME_EXECUTABLE_PATH=/path/to/chrome npm run test:e2e   # SIGKILL recovery + real-browser flow
```
A DB-backed suite that cannot reach a database reports **skipped**, never passed.

## Security notes
- Passwords are handled by Supabase Auth (production); OTPs are hashed. This codebase never stores a plaintext password or code.
- Admin access is decided from `public.user_roles` on the server and in RLS, never from a client-supplied claim.
- Test results are only readable by their owner (RLS and API ownership checks). Another user's id returns an identical 404.
- Users must confirm they are authorised to test a target. Testing is passive and non-destructive.
