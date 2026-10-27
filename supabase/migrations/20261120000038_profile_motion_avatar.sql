-- 38: Short motion profile pictures (a clip of about 5 seconds, like Facebook's profile video).
--
-- profiles.avatar_motion_path points at a short silent clip (MP4 or WebM, at most 8 MB) the owner uploaded to the media bucket.
-- The still picture (avatar_path, a frame taken from the clip) stays the avatar everywhere in the app, so every list, chat and
-- notification keeps loading a tiny image; only the profile screen plays the clip, looping and muted.
--  * Owner-only: column UPDATE on avatar_motion_path for authenticated, and a trigger that insists the path is in the owner's own
--    folder and is a finished video upload of a sensible size (the app checks the 5-second length; the database cannot read it).
--  * Everyone who can read a profile can read its clip: media_select_visible gains one clause (everything else is migration 28's rule).
--  * Public column, like avatar_path.
-- Additive. Rollback: restore migration 28's media_select_visible; drop trigger profiles_motion_ok and its function;
-- revoke the grants; alter table public.profiles drop column avatar_motion_path.

alter table public.profiles add column if not exists avatar_motion_path text;
grant select (avatar_motion_path) on public.profiles to authenticated;
grant update (avatar_motion_path) on public.profiles to authenticated;

create or replace function public.trg_profiles_motion_ok() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.avatar_motion_path is null then return new; end if;
  if tg_op = 'UPDATE' and new.avatar_motion_path is not distinct from old.avatar_motion_path then return new; end if;
  if new.avatar_motion_path not like new.id::text || '/%' then
    raise exception 'A profile clip must be your own upload' using errcode = '23514';
  end if;
  if not exists (select 1 from storage.objects o
                 where o.bucket_id = 'media' and o.name = new.avatar_motion_path
                   and coalesce(o.metadata ->> 'mimetype', '') in ('video/mp4', 'video/webm')
                   and coalesce((o.metadata ->> 'size')::bigint, 0) <= 8 * 1024 * 1024) then
    raise exception 'The clip has not finished uploading, or is not an MP4/WebM file of 8 MB or less' using errcode = '23514';
  end if;
  return new;
end $$;
drop trigger if exists profiles_motion_ok on public.profiles;
create trigger profiles_motion_ok before insert or update of avatar_motion_path on public.profiles
  for each row execute function public.trg_profiles_motion_ok();
revoke execute on function public.trg_profiles_motion_ok() from public, anon, authenticated;

-- Migration 28's media read rule plus the profile clip.
drop policy if exists media_select_visible on storage.objects;
create policy media_select_visible on storage.objects for select to authenticated
  using (
    bucket_id = 'media' and (
      (storage.foldername(objects.name))[1] = (select auth.uid())::text
      or exists (select 1 from public.posts p where p.media_path = objects.name or p.music_path = objects.name)
      or exists (select 1 from public.post_media pm where pm.path = objects.name or pm.poster_path = objects.name or pm.display_path = objects.name)
      or exists (select 1 from public.comments c where c.audio_path = objects.name or c.video_path = objects.name)
      or exists (select 1 from public.profiles pr where pr.avatar_path = objects.name or pr.cover_path = objects.name or pr.avatar_motion_path = objects.name)
      or exists (select 1 from public.events e where e.cover_path = objects.name or e.hero_video_path = objects.name)
      or exists (select 1 from public.event_lineup l where l.image_path = objects.name)
      or exists (select 1 from public.communities c where c.cover_path = objects.name)
      or exists (select 1 from public.memories m where m.media_path = objects.name or m.music_path = objects.name)
      or exists (select 1 from public.memory_replies r where r.audio_path = objects.name)
      or exists (select 1 from public.messages m where m.media_path = objects.name or m.audio_path = objects.name)
      or exists (select 1 from public.organizations o where o.avatar_path = objects.name or o.cover_path = objects.name)
      or exists (select 1 from public.media_assets a where a.organization_id is not null and (a.path = objects.name or a.thumb_path = objects.name))
      or exists (select 1 from public.event_evidence ev where ev.file_path = objects.name)
    )
  );
