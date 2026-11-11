-- Phase 2: authentication support tables.

alter table public.profiles add column if not exists terms_accepted_at timestamptz;

-- One-time email codes. Only a keyed hash (HMAC with a server-side secret) is stored, never the code itself.
create table public.otp_codes (
  id           uuid primary key default gen_random_uuid(),
  email        text not null,
  purpose      text not null check (purpose in ('signup', 'password_reset')),
  code_hash    text not null,
  expires_at   timestamptz not null,
  attempts     integer not null default 0,
  max_attempts integer not null default 5,
  consumed_at  timestamptz,
  ip           text,
  created_at   timestamptz not null default now()
);
create index otp_codes_lookup_idx on public.otp_codes (lower(email), purpose, created_at desc);

-- Generic sliding-window counters for unauthenticated endpoints (signup, OTP verification, password reset).
create table public.auth_attempts (
  id         bigint generated always as identity primary key,
  kind       text not null,
  key        text not null,
  created_at timestamptz not null default now()
);
create index auth_attempts_lookup_idx on public.auth_attempts (kind, key, created_at desc);

alter table public.otp_codes     enable row level security;
alter table public.auth_attempts enable row level security;
-- No policies: only the server (service role / owner connection) can touch these tables.
revoke all on public.otp_codes, public.auth_attempts from anon, authenticated;
