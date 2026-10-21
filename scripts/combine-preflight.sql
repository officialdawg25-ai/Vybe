-- Pre-flight: stop before changing anything if the database is missing what these migrations build on (migrations 1–13).
do $$
declare missing text[] := array[]::text[];
begin
  if to_regclass('public.chat_keys') is null then missing := array_append(missing, 'chat_keys (migration 13)'); end if;
  if to_regclass('public.chat_key_backups') is null then missing := array_append(missing, 'chat_key_backups (migration 13)'); end if;
  if to_regclass('public.calls') is null then missing := array_append(missing, 'calls (migration 12)'); end if;
  if to_regclass('public.promo_slides') is null then missing := array_append(missing, 'promo_slides (migration 9)'); end if;
  if to_regclass('public.organization_members') is null then missing := array_append(missing, 'organization_members (migration 3)'); end if;
  if not exists (select 1 from pg_proc where proname = 'is_admin' and pronamespace = 'public'::regnamespace) then missing := array_append(missing, 'is_admin() (migration 4)'); end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'messages' and column_name = 'e2ee') then missing := array_append(missing, 'messages.e2ee (migration 13)'); end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'posts' and column_name = 'music_path') then missing := array_append(missing, 'posts.music_path (migration 12)'); end if;
  if to_regclass('public.event_lineup') is null then missing := array_append(missing, 'event_lineup (migration 6)'); end if;
  if array_length(missing, 1) > 0 then
    raise exception 'Stopped before changing anything. Apply the earlier migrations first; missing: %', array_to_string(missing, ', ');
  end if;
  -- Existing rows that the new rules would reject (none expected; checked so the run cannot half-fail).
  if exists (select 1 from public.posts where body = '' and media_path is null and music_title is null and music_path is null and feeling is null and place_name is null) then
    raise exception 'Stopped: some posts have no content at all; the new posts_has_content rule would reject them.';
  end if;
  if exists (select 1 from public.promo_slides where status not in ('draft','submitted','rejected','live','paused')) then
    raise exception 'Stopped: a promo slide has an unknown status.';
  end if;
end $$;
