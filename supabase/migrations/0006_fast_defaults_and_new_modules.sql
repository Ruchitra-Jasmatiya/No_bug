-- Faster test runs and the two new modules (pagination testing, site pages & URL validation).
-- Idempotent. Only touches values that still hold the previous defaults, so admin edits are never overwritten.

update public.app_settings
   set value = '{"job_ms": 240000, "module_ms": 80000, "navigation_ms": 20000}'::jsonb
 where key = 'timeouts'
   and value = '{"job_ms": 600000, "module_ms": 120000, "navigation_ms": 30000}'::jsonb;

update public.app_settings
   set value = value || '["pagination","site_pages"]'::jsonb
 where key = 'enabled_modules'
   and jsonb_typeof(value) = 'array'
   and value ? 'links_resources'
   and not (value ? 'pagination');
