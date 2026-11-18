-- WhatsApp-number sign-up and a front-end-only default test scope. Idempotent.

alter table public.profiles add column if not exists whatsapp_number text;
create index if not exists profiles_whatsapp_idx on public.profiles (whatsapp_number) where whatsapp_number is not null;
create index if not exists profiles_phone_idx on public.profiles (phone) where phone is not null;

-- The product tests the FRONT END of a site. Backend/API probing is switched off by default (an admin can switch it back on).
update public.app_settings
   set value = value - 'api'
 where key = 'enabled_modules'
   and jsonb_typeof(value) = 'array'
   and value ? 'api';
