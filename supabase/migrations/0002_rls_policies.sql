-- Row Level Security.
-- Principle: browsers (anon / authenticated roles) may READ their own data and the data they are
-- entitled to; every WRITE to server-managed tables goes through the API using the service role,
-- which performs its own ownership and role validation. Roles are never trusted from client claims.

alter table public.profiles               enable row level security;
alter table public.user_roles             enable row level security;
alter table public.app_settings           enable row level security;
alter table public.test_projects          enable row level security;
alter table public.test_jobs              enable row level security;
alter table public.test_modules           enable row level security;
alter table public.test_results           enable row level security;
alter table public.bug_reports            enable row level security;
alter table public.test_logs              enable row level security;
alter table public.test_screenshots       enable row level security;
alter table public.chatbot_conversations  enable row level security;
alter table public.chatbot_messages       enable row level security;
alter table public.login_events           enable row level security;
alter table public.security_events        enable row level security;
alter table public.email_notifications    enable row level security;
alter table public.audit_logs             enable row level security;
alter table public.user_sessions          enable row level security;

-- Ownership helper used by child-table policies (security definer avoids recursive RLS evaluation).
create or replace function public.owns_job(p_job_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.test_jobs j where j.id = p_job_id and j.user_id = auth.uid());
$$;

create or replace function public.owns_conversation(p_conversation_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.chatbot_conversations c where c.id = p_conversation_id and c.user_id = auth.uid());
$$;

-- profiles / roles -----------------------------------------------------------
create policy profiles_select on public.profiles
  for select to authenticated using (id = auth.uid() or public.is_admin());

create policy user_roles_select on public.user_roles
  for select to authenticated using (user_id = auth.uid() or public.is_admin());

-- settings: public keys are readable by everyone (so the UI can follow admin changes live) -------------
create policy app_settings_select_public on public.app_settings
  for select to anon, authenticated using (is_public);
create policy app_settings_select_admin on public.app_settings
  for select to authenticated using (public.is_admin());

-- testing domain -------------------------------------------------------------
create policy test_projects_select on public.test_projects
  for select to authenticated using (user_id = auth.uid() or public.is_admin());

create policy test_jobs_select on public.test_jobs
  for select to authenticated using (user_id = auth.uid() or public.is_admin());

create policy test_modules_select on public.test_modules
  for select to authenticated using (public.owns_job(job_id) or public.is_admin());

create policy test_results_select on public.test_results
  for select to authenticated using (public.owns_job(job_id) or public.is_admin());

create policy bug_reports_select on public.bug_reports
  for select to authenticated using (public.owns_job(job_id) or public.is_admin());

create policy test_logs_select on public.test_logs
  for select to authenticated using (public.owns_job(job_id) or public.is_admin());

create policy test_screenshots_select on public.test_screenshots
  for select to authenticated using (public.owns_job(job_id) or public.is_admin());

-- chatbot: users manage their own conversations --------------------------------
create policy chatbot_conversations_select on public.chatbot_conversations
  for select to authenticated using (user_id = auth.uid());
create policy chatbot_conversations_insert on public.chatbot_conversations
  for insert to authenticated with check (user_id = auth.uid());
create policy chatbot_conversations_update on public.chatbot_conversations
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy chatbot_conversations_delete on public.chatbot_conversations
  for delete to authenticated using (user_id = auth.uid());

create policy chatbot_messages_select on public.chatbot_messages
  for select to authenticated using (public.owns_conversation(conversation_id));
-- Assistant messages are written by the API only; users may only insert their own turns.
create policy chatbot_messages_insert on public.chatbot_messages
  for insert to authenticated with check (role = 'user' and public.owns_conversation(conversation_id));

-- security data ----------------------------------------------------------------
create policy login_events_select on public.login_events
  for select to authenticated using (user_id = auth.uid() or public.is_admin());

create policy user_sessions_select on public.user_sessions
  for select to authenticated using (user_id = auth.uid() or public.is_admin());

create policy security_events_admin on public.security_events
  for select to authenticated using (public.is_admin());
create policy email_notifications_admin on public.email_notifications
  for select to authenticated using (public.is_admin());
create policy audit_logs_admin on public.audit_logs
  for select to authenticated using (public.is_admin());

-- Defence in depth: remove write privileges from browser roles on server-managed tables. ----------
do $$
declare t text;
begin
  foreach t in array array[
    'profiles','user_roles','app_settings','test_projects','test_jobs','test_modules','test_results',
    'bug_reports','test_logs','test_screenshots','login_events','security_events',
    'email_notifications','audit_logs','user_sessions'
  ] loop
    execute format('revoke insert, update, delete, truncate on public.%I from anon, authenticated', t);
  end loop;
  -- chatbot tables: only the writes allowed by the policies above
  revoke truncate on public.chatbot_conversations, public.chatbot_messages from anon, authenticated;
  revoke update, delete on public.chatbot_messages from anon, authenticated;
end $$;

-- Anonymous visitors can only read public settings.
do $$
declare t text;
begin
  foreach t in array array[
    'profiles','user_roles','test_projects','test_jobs','test_modules','test_results','bug_reports',
    'test_logs','test_screenshots','chatbot_conversations','chatbot_messages','login_events',
    'security_events','email_notifications','audit_logs','user_sessions'
  ] loop
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $$;

-- Realtime: live progress for the owner of a job (filtered by RLS). ---------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin alter publication supabase_realtime add table public.test_jobs;    exception when duplicate_object then null; end;
    begin alter publication supabase_realtime add table public.test_modules; exception when duplicate_object then null; end;
    begin alter publication supabase_realtime add table public.test_logs;    exception when duplicate_object then null; end;
    begin alter publication supabase_realtime add table public.app_settings; exception when duplicate_object then null; end;
  end if;
end $$;
