# NO BUGS ALLOWED — build status

> Honest status. Nothing is listed as working unless it was run and verified.
> Last verified: 2026-11-11 (Node 22, PostgreSQL 16, Redis 7, real Chrome).

**All 7 phases are built.** This is a complete codebase that has been verified end-to-end *locally*. It has **not** been
run against your real Supabase / Resend / Upstash / Railway / Anthropic accounts — see "Not verified" below.

## Verified (automated, all passing)

| Suite | Tests | What it proves |
|---|---|---|
| `shared` | 125 | SSRF/IP classification, DNS-rebinding, redirect re-validation, URL rules, AI providers (retry/timeout/auth), prompt-injection defences, AI response validation |
| `api` | 163 | Core API, JWT verification, auth (OTP, throttling, rotation, enumeration safety), Supabase identity adapter (against a stand-in server), BUGSY chat, admin API, security alerts, RLS against real PostgreSQL, config |
| `worker` | 45 | Orchestrator, crash-safe checkpoints, all 17 modules against buggy and clean fixture sites in real Chromium, AI analysis module |
| `web` | 4 | Formatting helpers |
| `e2e` (system) | 4 | API → Redis → real worker process → Chromium → Postgres; SIGKILL mid-test, second worker resumes without re-running finished modules |
| `e2e` (browser) | 14 | The **built web app in real Chrome**: home, sign-up validation, emailed OTP (wrong then right code), login, session survives reload, live test with offline banner, refresh-confirmation modal (Continue Testing / Start Again / Stay Here), report with real findings, filters, copy fix, PDF download, BUGSY honest "AI off" state, non-admin blocked from /admin, mobile layout without horizontal scroll, logout |

`npm run typecheck` is clean for all workspaces; `npm run build` builds everything.

## Behaviour you should know about (by design)
- A skipped/blocked module is never a pass. A run is **incomplete** when a selected test module was skipped/blocked/failed. A missing AI key does **not** make a run incomplete; AI explanations are simply reported as skipped.
- The report says *"No issues detected in the tests performed."* — never "bug-free".
- Without an AI key BUGSY says AI is off and still shows real test data; it never invents answers.
- After repeated failed logins, attempts are slowed progressively (5 s doubling to 15 min). **No CAPTCHA provider is integrated**; the server returns a `captchaRequired` flag which the UI shows as a notice only.
- Contact page shows no form (no public mail endpoint exists); set your support address in `web/src/pages/Static.tsx`.
- Terms and Privacy pages are starter templates, not legal advice.
- Visual regression stores baselines in PostgreSQL; the first run of a site records a baseline and reports *info*, not a pass.

## Not verified (could not be tested in the build sandbox)
- **Real Supabase** (Auth, hosted Postgres, RLS on the hosted project). Auth against Supabase GoTrue is verified only against a stand-in server; the local identity provider is dev/test only and refused in production.
- **Resend** email delivery, **Upstash** Redis TLS, **Railway/Render/Vercel** deployment, and `docker build` (no Docker daemon here; `docker compose config` is valid).
- **The Anthropic API** (and any other AI provider): the request/response handling is tested with stubbed HTTP; no real model call was made, so prompt quality is unverified.
- Browsers other than Chrome; real-device mobile testing (only emulated 375 px).
- Load/scale behaviour, and the sandbox-to-internet behaviour of the worker against arbitrary public sites.

## Known limitations
- Tests are passive: no authenticated crawling, form submission with real data, or destructive actions.
- Chromium downloads are blocked and permissions (camera, mic, location) denied during tests.
- Admin settings are edited as validated JSON, not bespoke forms.
