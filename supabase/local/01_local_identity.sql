-- LOCAL DEVELOPMENT / TESTS ONLY — never applied to Supabase (production uses Supabase Auth).
-- Backs the "local" identity provider: password hashes and rotating refresh tokens.

alter table auth.users add column if not exists encrypted_password text;

create table if not exists public.local_refresh_tokens (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  family_id   uuid not null,
  token_hash  text not null unique,
  expires_at  timestamptz not null,
  revoked_at  timestamptz,
  replaced_by uuid,
  ip          text,
  user_agent  text,
  created_at  timestamptz not null default now()
);
create index if not exists local_refresh_tokens_user_idx on public.local_refresh_tokens (user_id);
alter table public.local_refresh_tokens enable row level security;
revoke all on public.local_refresh_tokens from anon, authenticated;
