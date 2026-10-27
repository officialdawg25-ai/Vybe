-- 39: Video editing and post controls.
--
-- The composer's video editor (trim start and end, sound off, a song) is non-destructive: the original upload is kept and the
-- choices are stored beside it, then applied when the video plays.
--   post_media.trim_start_ms / trim_end_ms  play only this part (at least half a second, in order); NULL = the whole video
--   post_media.muted                        play without the video's own sound (a song, or silence)
-- Post controls the author chooses while posting, and can change later:
--   posts.comments_off  nobody can add a comment or reply (the database refuses it; existing comments stay readable)
--   posts.hide_counts   likes and comment counts are not shown to others
-- Additive. Rollback: drop trigger comments_allowed and its function; drop the columns and the two constraints;
-- revoke update (comments_off, hide_counts) on public.posts from authenticated.

alter table public.post_media add column if not exists trim_start_ms integer;
alter table public.post_media add column if not exists trim_end_ms integer;
alter table public.post_media add column if not exists muted boolean not null default false;
alter table public.post_media drop constraint if exists post_media_trim_ok;
alter table public.post_media add constraint post_media_trim_ok check (
  (trim_start_ms is null or trim_start_ms between 0 and 86400000)
  and (trim_end_ms is null or trim_end_ms between 500 and 86400000)
  and (trim_start_ms is null or trim_end_ms is null or trim_end_ms >= trim_start_ms + 500)
  and (type = 'video' or (trim_start_ms is null and trim_end_ms is null and not muted)));

alter table public.posts add column if not exists comments_off boolean not null default false;
alter table public.posts add column if not exists hide_counts boolean not null default false;
grant insert (comments_off, hide_counts) on public.posts to authenticated;
grant update (comments_off, hide_counts) on public.posts to authenticated;

create or replace function public.trg_comments_allowed() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.posts p where p.id = new.post_id and p.comments_off) then
    raise exception 'Comments are turned off for this post' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists comments_allowed on public.comments;
create trigger comments_allowed before insert on public.comments for each row execute function public.trg_comments_allowed();
revoke execute on function public.trg_comments_allowed() from public, anon, authenticated;
