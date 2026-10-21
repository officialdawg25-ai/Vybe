-- Verification (read-only): every row should say ok = true.
select item, ok from (values
  ('14: chat key functions', exists (select 1 from pg_proc where proname = 'publish_chat_key') and exists (select 1 from pg_proc where proname = 'update_chat_backups')),
  ('14: group encryption', to_regclass('public.conversation_keys') is not null and exists (select 1 from pg_trigger where tgname = 'message_encryption')),
  ('14: recovery tables', to_regclass('public.chat_recovery_requests') is not null and to_regclass('public.chat_key_escrow') is not null and to_regclass('public.chat_key_events') is not null),
  ('15: posts_has_content replaces posts_check', exists (select 1 from pg_constraint where conname = 'posts_has_content') and not exists (select 1 from pg_constraint where conname = 'posts_check' and conrelid = 'public.posts'::regclass)),
  ('15: 14-day name rule', exists (select 1 from pg_trigger where tgname = 'trg_limit_display_name')),
  ('16: campaign columns', exists (select 1 from information_schema.columns where table_name = 'promo_slides' and column_name = 'placements')),
  ('16: campaign rules', exists (select 1 from pg_trigger where tgname = 'trg_promo_guard') and exists (select 1 from pg_trigger where tgname = 'trg_promo_audit')),
  ('16: notification types include security and campaign', pg_get_constraintdef((select oid from pg_constraint where conname = 'notifications_type_check')) like '%security%campaign%'),
  ('17: profiles private columns hidden', not has_column_privilege('authenticated', 'public.profiles', 'lat', 'select') and has_column_privilege('authenticated', 'public.profiles', 'display_name', 'select')),
  ('17: my_profile()', exists (select 1 from pg_proc where proname = 'my_profile'))
) as v(item, ok);
