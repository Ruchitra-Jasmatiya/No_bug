-- Default application settings. Admin-editable at runtime; none of these values are secrets.
-- AI settings hold only a model *reference*; API keys live in environment variables on the server.

insert into public.app_settings (key, value, description, is_public) values
  ('enabled_modules',
   '["connectivity","browser_launch","page_inspection","console","report_generation"]'::jsonb,
   'Test modules available to users. System modules always run.', true),
  ('timeouts',
   '{"job_ms": 600000, "module_ms": 120000, "navigation_ms": 30000}'::jsonb,
   'Default execution timeouts for testing jobs.', false),
  ('concurrency',
   '{"max_concurrent_jobs": 2, "max_active_jobs_per_user": 2}'::jsonb,
   'Concurrent job limits (global worker concurrency and per-user active jobs).', false),
  ('rate_limits',
   '{"tests_per_hour_per_user": 20, "tests_per_hour_per_domain": 30}'::jsonb,
   'Rate limits applied when creating testing jobs.', false),
  ('crawl_limits',
   '{"max_pages": 10, "max_depth": 1, "max_download_bytes": 5242880}'::jsonb,
   'Bounds on how much of a target site a job may fetch.', false),
  ('notifications',
   '{"test_completed_email": false, "security_alert_email": true}'::jsonb,
   'Notification preferences.', false),
  ('ai',
   '{"provider": "anthropic", "model_env": "AI_MODEL", "max_findings_per_job": 25}'::jsonb,
   'AI analysis configuration references. The key itself is never stored here.', false),
  ('login_security',
   '{"failed_login_threshold": 10, "window_minutes": 15, "captcha_after_failures": 5}'::jsonb,
   'Thresholds for suspicious login detection and alerting.', false)
on conflict (key) do nothing;
