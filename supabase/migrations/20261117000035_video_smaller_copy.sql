-- Migration 35: a video can carry a smaller playback copy, so viewers get a real quality choice.
--  * post_media.display_path, until now only the phone-sized copy of a photo (migration 25), may also hold a smaller copy
--    of a video (at most 480p). The uploader's device makes it after the post is published (publishing never waits for
--    it), so the author may add, replace or remove it later: column-level UPDATE on display_path only, for their own rows.
--  * Whatever display_path points to must be the author's own, finished upload of the right kind (an image for a photo,
--    a video for a video) and never the original itself. Checked by a trigger against storage.objects.
--  * Reading needs nothing new: media_select_visible already lets viewers of a post read its display_path objects.
-- Backward compatible: older apps never set display_path on videos; viewers without the copy play the original.
-- Rollback: drop trigger post_media_display_ok and its function; drop policy post_media_upd_display;
-- revoke update (display_path) on public.post_media from authenticated; restore migration 25's post_media_ins.

drop policy if exists post_media_ins on public.post_media;
create policy post_media_ins on public.post_media for insert to authenticated
  with check (exists (select 1 from public.posts p where p.id = post_id and p.author = (select auth.uid()))
              and path like (select auth.uid())::text || '/%'
              and (poster_path is null or poster_path like (select auth.uid())::text || '/%')
              and (display_path is null or (display_path like (select auth.uid())::text || '/%' and display_path <> path)));

grant update (display_path) on public.post_media to authenticated;
drop policy if exists post_media_upd_display on public.post_media;
create policy post_media_upd_display on public.post_media for update to authenticated
  using (exists (select 1 from public.posts p where p.id = post_id and p.author = (select auth.uid())))
  with check (exists (select 1 from public.posts p where p.id = post_id and p.author = (select auth.uid()))
              and (display_path is null or (display_path like (select auth.uid())::text || '/%' and display_path <> path)));

create or replace function public.trg_post_media_display_ok() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.display_path is null then return new; end if;
  if tg_op = 'UPDATE' and new.display_path is not distinct from old.display_path then return new; end if;
  if not exists (select 1 from storage.objects o
                 where o.bucket_id = 'media' and o.name = new.display_path
                   and coalesce(o.metadata ->> 'mimetype', '') like (case when new.type = 'video' then 'video/%' else 'image/%' end)) then
    raise exception 'The smaller copy has not finished uploading, or is not a % file', new.type using errcode = '23514';
  end if;
  return new;
end $$;
drop trigger if exists post_media_display_ok on public.post_media;
create trigger post_media_display_ok before insert or update of display_path on public.post_media
  for each row execute function public.trg_post_media_display_ok();
revoke execute on function public.trg_post_media_display_ok() from public, anon, authenticated;
