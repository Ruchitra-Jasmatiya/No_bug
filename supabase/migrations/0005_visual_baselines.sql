-- Visual regression baselines (PNG screenshots, one per user + page + viewport) and the Phase 3 module defaults.
create table if not exists public.visual_baselines (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  page_url    text not null,
  viewport    text not null,
  width       integer not null,
  height      integer not null,
  image       bytea not null,
  job_id      uuid references public.test_jobs (id) on delete set null,
  created_at  timestamptz not null default now(),
  unique (user_id, page_url, viewport)
);
alter table public.visual_baselines enable row level security;
-- Images are written and read only by the server; browser roles get nothing.
revoke all on public.visual_baselines from anon, authenticated;

update public.app_settings
   set value = '["connectivity","browser_launch","page_inspection","console","functional","ui","responsive","performance","accessibility","seo","security","links_resources","api","visual_regression","pwa","report_generation"]'::jsonb
 where key = 'enabled_modules'
   and value = '["connectivity","browser_launch","page_inspection","console","report_generation"]'::jsonb;
