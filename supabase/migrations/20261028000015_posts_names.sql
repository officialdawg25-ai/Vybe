-- 15: posts with only a song, feeling or place; display-name changes limited to once every 14 days.
--
--  * posts_check required a caption or a photo, so a post with only a song (or only a feeling or place) was rejected with
--    'new row for relation "posts" violates check constraint "posts_check"'. The rule now accepts any real content.
--  * profiles.display_name_changed_at records the last name change; a trigger refuses another change within 14 days.
--    Onboarding (before onboarded_at is set) and server-side/admin updates (no auth.uid()) are not limited.
-- Non-destructive: no data is rewritten. Rollback: restore the old check and drop the trigger, function and column.

alter table public.posts drop constraint if exists posts_check;
alter table public.posts drop constraint if exists posts_has_content;
alter table public.posts add constraint posts_has_content check (
  body <> '' or media_path is not null or music_title is not null or music_path is not null
  or feeling is not null or place_name is not null
);

alter table public.profiles add column if not exists display_name_changed_at timestamptz;

create or replace function public.limit_display_name_change()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then
    return new;
  end if;
  if new.display_name is not distinct from old.display_name then
    new.display_name_changed_at := old.display_name_changed_at;
    return new;
  end if;
  if old.onboarded_at is null then
    return new;
  end if;
  if old.display_name_changed_at is not null and old.display_name_changed_at > now() - interval '14 days' then
    raise exception 'You can change your name again on %.', to_char(old.display_name_changed_at + interval '14 days', 'FMDD Mon YYYY')
      using errcode = 'check_violation', hint = 'name_cooldown';
  end if;
  new.display_name_changed_at := now();
  return new;
end $$;
revoke all on function public.limit_display_name_change() from public, anon, authenticated;

drop trigger if exists trg_limit_display_name on public.profiles;
create trigger trg_limit_display_name before update of display_name, display_name_changed_at on public.profiles
  for each row execute function public.limit_display_name_change();
