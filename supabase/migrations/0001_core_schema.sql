-- NO BUGS ALLOWED — core schema
-- Requires Supabase (auth.users, auth.uid()). For plain Postgres development see supabase/local/00_auth_stub.sql.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- helpers
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- identity
-- ---------------------------------------------------------------------------
create table public.profiles (
  id                uuid primary key references auth.users (id) on delete cascade,
  full_name         text not null default '',
  email             text not null,
  phone             text,
  account_status    text not null default 'active' check (account_status in ('active', 'suspended')),
  suspended_reason  text,
  email_verified_at timestamptz,
  last_login_at     timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create unique index profiles_email_lower_key on public.profiles (lower(email));
create trigger profiles_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();

create table public.user_roles (
  user_id    uuid not null references auth.users (id) on delete cascade,
  role       text not null check (role in ('user', 'admin')),
  granted_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (user_id, role)
);

-- Role checks always happen server-side against this table, never from client claims.
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.user_roles ur
    join public.profiles p on p.id = ur.user_id
    where ur.user_id = auth.uid() and ur.role = 'admin' and p.account_status = 'active'
  );
$$;

-- Create a profile and default role whenever an auth user is created.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name, phone, email_verified_at)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(new.raw_user_meta_data ->> 'full_name', ''),
    nullif(new.raw_user_meta_data ->> 'phone', ''),
    new.email_confirmed_at
  )
  on conflict (id) do nothing;
  insert into public.user_roles (user_id, role) values (new.id, 'user') on conflict do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- application settings (admin-editable, never holds secrets)
-- ---------------------------------------------------------------------------
create table public.app_settings (
  key         text primary key,
  value       jsonb not null,
  description text not null default '',
  is_public   boolean not null default false,
  updated_by  uuid references auth.users (id) on delete set null,
  updated_at  timestamptz not null default now()
);
create trigger app_settings_updated_at before update on public.app_settings
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- testing domain
-- ---------------------------------------------------------------------------
create table public.test_projects (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  name       text not null,
  base_url   text not null,
  hostname   text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, base_url)
);
create trigger test_projects_updated_at before update on public.test_projects
  for each row execute function public.set_updated_at();

create table public.test_jobs (
  id                    uuid primary key default gen_random_uuid(),
  project_id            uuid not null references public.test_projects (id) on delete cascade,
  user_id               uuid not null references auth.users (id) on delete cascade,
  target_url            text not null,
  hostname              text not null,
  status                text not null default 'queued'
                          check (status in ('queued', 'running', 'completed', 'failed', 'cancelled')),
  progress_pct          integer not null default 0 check (progress_pct between 0 and 100),
  selected_modules      text[] not null,
  current_module        text,
  last_completed_module text,
  options               jsonb not null default '{}'::jsonb,
  attempt               integer not null default 0,
  max_attempts          integer not null default 3,
  locked_by             text,
  heartbeat_at          timestamptz,
  cancel_requested      boolean not null default false,
  error_message         text,
  summary               jsonb,
  idempotency_key       text,
  restart_of            uuid references public.test_jobs (id) on delete set null,
  queued_at             timestamptz not null default now(),
  started_at            timestamptz,
  finished_at           timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create unique index test_jobs_idempotency_key on public.test_jobs (user_id, idempotency_key) where idempotency_key is not null;
create index test_jobs_user_created_idx on public.test_jobs (user_id, created_at desc);
create index test_jobs_project_idx on public.test_jobs (project_id, created_at desc);
create index test_jobs_status_heartbeat_idx on public.test_jobs (status, heartbeat_at) where status in ('queued', 'running');
create trigger test_jobs_updated_at before update on public.test_jobs
  for each row execute function public.set_updated_at();

-- One row per module per job. This is the checkpoint table: a module in a settled
-- state (completed / failed / skipped / blocked) is never rerun on recovery.
create table public.test_modules (
  id            uuid primary key default gen_random_uuid(),
  job_id        uuid not null references public.test_jobs (id) on delete cascade,
  module_id     text not null,
  position      integer not null,
  status        text not null default 'pending'
                  check (status in ('pending', 'running', 'completed', 'failed', 'skipped', 'blocked')),
  attempt       integer not null default 0,
  note          text,
  error_message text,
  checkpoint    jsonb not null default '{}'::jsonb,
  counts        jsonb not null default '{}'::jsonb,
  started_at    timestamptz,
  finished_at   timestamptz,
  duration_ms   integer,
  updated_at    timestamptz not null default now(),
  unique (job_id, module_id)
);
create index test_modules_job_position_idx on public.test_modules (job_id, position);
create trigger test_modules_updated_at before update on public.test_modules
  for each row execute function public.set_updated_at();

create table public.test_results (
  id           uuid primary key default gen_random_uuid(),
  job_id       uuid not null references public.test_jobs (id) on delete cascade,
  module_id    text not null,
  category     text not null,
  check_key    text not null,
  title        text not null,
  status       text not null check (status in ('pass', 'fail', 'warning', 'info', 'skipped', 'blocked')),
  severity     text check (severity in ('critical', 'high', 'medium', 'low', 'informational')),
  confidence   text check (confidence in ('confirmed', 'potential', 'informational')),
  affected_url text not null default '',
  message      text not null default '',
  evidence     jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  -- Idempotency: re-running a module after a crash can never duplicate a result.
  unique (job_id, module_id, check_key, affected_url)
);
create index test_results_job_status_idx on public.test_results (job_id, status);
create index test_results_job_module_idx on public.test_results (job_id, module_id);

create sequence public.bug_code_seq start 1;

create table public.bug_reports (
  id            uuid primary key default gen_random_uuid(),
  issue_code    text not null unique default ('NBA-' || lpad(nextval('public.bug_code_seq')::text, 6, '0')),
  job_id        uuid not null references public.test_jobs (id) on delete cascade,
  result_id     uuid not null unique references public.test_results (id) on delete cascade,
  category      text not null,
  severity      text not null check (severity in ('critical', 'high', 'medium', 'low', 'informational')),
  confidence    text not null check (confidence in ('confirmed', 'potential', 'informational')),
  title         text not null,
  description   text not null,
  affected_url  text not null default '',
  evidence      jsonb not null default '{}'::jsonb,   -- raw test evidence, never overwritten by AI
  environment   jsonb not null default '{}'::jsonb,
  suggested_fix text not null default '',
  ai_status     text not null default 'pending' check (ai_status in ('pending', 'completed', 'failed', 'skipped')),
  ai_analysis   jsonb,                                 -- AI output is stored separately from evidence
  status        text not null default 'open' check (status in ('open', 'resolved', 'ignored')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index bug_reports_job_idx on public.bug_reports (job_id, severity);
create trigger bug_reports_updated_at before update on public.bug_reports
  for each row execute function public.set_updated_at();

create table public.test_logs (
  id         bigint generated always as identity primary key,
  job_id     uuid not null references public.test_jobs (id) on delete cascade,
  module_id  text,
  level      text not null default 'info' check (level in ('debug', 'info', 'warn', 'error')),
  message    text not null,
  meta       jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index test_logs_job_id_idx on public.test_logs (job_id, id);

create table public.test_screenshots (
  id           uuid primary key default gen_random_uuid(),
  job_id       uuid not null references public.test_jobs (id) on delete cascade,
  result_id    uuid references public.test_results (id) on delete set null,
  storage_path text not null,
  viewport     text,
  width        integer,
  height       integer,
  taken_at     timestamptz not null default now()
);
create index test_screenshots_job_idx on public.test_screenshots (job_id);

-- ---------------------------------------------------------------------------
-- chatbot
-- ---------------------------------------------------------------------------
create table public.chatbot_conversations (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  job_id     uuid references public.test_jobs (id) on delete set null,
  title      text not null default 'New conversation',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index chatbot_conversations_user_idx on public.chatbot_conversations (user_id, updated_at desc);
create trigger chatbot_conversations_updated_at before update on public.chatbot_conversations
  for each row execute function public.set_updated_at();

create table public.chatbot_messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.chatbot_conversations (id) on delete cascade,
  role            text not null check (role in ('user', 'assistant')),
  content         text not null,
  metadata        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);
create index chatbot_messages_conversation_idx on public.chatbot_messages (conversation_id, created_at);

-- ---------------------------------------------------------------------------
-- security & operations
-- ---------------------------------------------------------------------------
create table public.login_events (
  id         bigint generated always as identity primary key,
  user_id    uuid references auth.users (id) on delete set null,
  email      text not null,
  success    boolean not null,
  reason     text,
  ip         text,
  user_agent text,
  created_at timestamptz not null default now()
);
create index login_events_email_idx on public.login_events (lower(email), created_at desc);
create index login_events_ip_idx on public.login_events (ip, created_at desc);
create index login_events_created_idx on public.login_events (created_at desc);

create table public.security_events (
  id             uuid primary key default gen_random_uuid(),
  kind           text not null,
  risk_level     text not null check (risk_level in ('low', 'medium', 'high', 'critical')),
  user_id        uuid references auth.users (id) on delete set null,
  email          text,
  attempt_count  integer,
  ip             text,
  user_agent     text,
  action_taken   text,
  details        jsonb not null default '{}'::jsonb,
  dedupe_key     text,
  acknowledged_by uuid references auth.users (id) on delete set null,
  acknowledged_at timestamptz,
  created_at     timestamptz not null default now()
);
create index security_events_created_idx on public.security_events (created_at desc);
create unique index security_events_dedupe_idx on public.security_events (dedupe_key) where dedupe_key is not null;

create table public.email_notifications (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid references auth.users (id) on delete set null,
  to_email            text not null,
  template            text not null,
  subject             text not null,
  status              text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  provider_message_id text,
  error               text,
  created_at          timestamptz not null default now(),
  sent_at             timestamptz
);
create index email_notifications_created_idx on public.email_notifications (created_at desc);

create table public.audit_logs (
  id          bigint generated always as identity primary key,
  actor_id    uuid references auth.users (id) on delete set null,
  action      text not null,
  target_type text,
  target_id   text,
  metadata    jsonb not null default '{}'::jsonb,
  ip          text,
  created_at  timestamptz not null default now()
);
create index audit_logs_created_idx on public.audit_logs (created_at desc);
create index audit_logs_actor_idx on public.audit_logs (actor_id, created_at desc);

create table public.user_sessions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  ip           text,
  user_agent   text,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at   timestamptz
);
create index user_sessions_user_idx on public.user_sessions (user_id, created_at desc);
