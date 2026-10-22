-- Migration 22: reels, video notes, personal live notifications, choosing a username at onboarding, username sign-in
-- throttle, and the admin music upload fix. Additive and re-runnable; no existing data is rewritten.
--
-- 1. Admin music uploads were refused ("new row violates row-level security policy"): migration 16 rewrote the brand
--    bucket's insert rule for campaigns and dropped the music/ folder that migration 11 had allowed. It is back.
-- 2. Personal live streams (no event) notified nobody: notify_live_started returned early without an event. Friends and
--    followers are now told (friends only for a friends-only stream), plus the organisation's followers when it is a page's.
-- 3. Reels are posts with one vertical video (posts.is_reel). They reuse likes, comments, saves and sharing.
-- 4. Video notes: comments.video_path/video_ms (in the author's own folder, like voice notes) and messages.video_note for
--    unencrypted chats. Encrypted chats carry the flag inside the encrypted envelope, so the server never sees it.
-- 5. Usernames: people who signed up with Google (or whose wanted name was taken) get a generated one; they can choose
--    their own once, during onboarding (set_username). Google names now fill the display name.
-- 6. login_attempts: the username sign-in Edge Function records attempts per hashed IP and per username so it can slow
--    down guessing. No browser role can read or write it.
--
-- Rollback: drop the functions/triggers/tables named below and the columns posts.is_reel, comments.video_path,
-- comments.video_ms, messages.video_note; re-run brand_admin_insert from migration 16 and notify_live_started from 10.

-- ---------------------------------------------------------------- 1. brand bucket: hero, promo and music (admins); organisation campaigns
drop policy if exists brand_admin_insert on storage.objects;
create policy brand_admin_insert on storage.objects for insert to authenticated
  with check (
    (bucket_id in ('brand', 'brand-draft') and public.is_admin() and name ~ '^(hero|promo)/[0-9a-f-]{36}\.(jpg|png|webp|mp4|webm)$')
    or (bucket_id = 'brand' and public.is_admin() and name ~ '^music/[0-9a-f-]{36}\.(jpg|png|webp|mp3|m4a|ogg)$')
    or (bucket_id = 'brand' and name ~ '^promo/o-[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|png|webp|mp4|webm)$'
        and public.can_manage_campaigns(substring(name from '^promo/o-([0-9a-f-]{36})/')::uuid)));

-- ---------------------------------------------------------------- 2. personal live: tell friends and followers
create or replace function public.notify_live_started(sid uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare s public.live_streams; e public.events; who uuid[];
begin
  select * into s from public.live_streams where id = sid;
  if not found then return; end if;
  if s.event_id is null then
    -- Someone going live themselves (or as their page): their friends, and for public streams their followers too.
    select coalesce(array_agg(distinct x), '{}') into who from (
      select case when f.requester = s.host then f.addressee else f.requester end as x
        from public.friendships f where f.status = 'accepted' and (f.requester = s.host or f.addressee = s.host)
      union
      select fo.follower from public.follows fo where s.visibility = 'public' and fo.target_type = 'profile' and fo.target_id = s.host
      union
      select fo.follower from public.follows fo where s.visibility = 'public' and s.organization_id is not null and fo.target_type = 'organization' and fo.target_id = s.organization_id
    ) t;
    perform public.notify_many(who, 'live_started', 'live_started', s.host, 'live', s.id, 'live:' || s.id);
    return;
  end if;
  if s.visibility <> 'public' then return; end if;
  select * into e from public.events where id = s.event_id;
  if not found or e.status <> 'active' then return; end if;
  if s.access = 'ticket' then
    select coalesce(array_agg(distinct owner), '{}') into who from public.tickets where event_id = e.id and status in ('valid', 'used');
  else
    who := public.event_attendees(e.id) || public.event_followers(e);
  end if;
  perform public.notify_many(who, 'live_started', 'live_started', s.host, 'live', s.id, 'live:' || s.id);
end $$;
revoke execute on function public.notify_live_started(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------- 3. reels
alter table public.posts add column if not exists is_reel boolean not null default false;
alter table public.posts drop constraint if exists posts_reel_is_video;
alter table public.posts add constraint posts_reel_is_video check (not is_reel or (media_type = 'video' and media_path is not null));
create index if not exists posts_reels_idx on public.posts (created_at desc) where is_reel;

-- ---------------------------------------------------------------- 4. video notes
alter table public.comments add column if not exists video_path text;
alter table public.comments add column if not exists video_ms integer;
alter table public.comments drop constraint if exists comments_video_valid;
alter table public.comments add constraint comments_video_valid
  check ((video_path is null) = (video_ms is null) and (video_ms is null or video_ms between 500 and 120000)
         and (video_path is null or video_path like author::text || '/%'));
alter table public.comments drop constraint if exists comments_body_or_audio;
alter table public.comments add constraint comments_body_or_audio
  check (char_length(body) <= 2000 and (char_length(body) >= 1 or audio_path is not null or video_path is not null));
alter table public.messages add column if not exists video_note boolean not null default false;
alter table public.messages drop constraint if exists messages_video_note_is_video;
alter table public.messages add constraint messages_video_note_is_video check (not video_note or media_type = 'video');

-- ---------------------------------------------------------------- 5. usernames
-- Display name from Google ("full_name"/"name") when signing up with Google; everything else as before.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  wanted text := lower(coalesce(new.raw_user_meta_data->>'username', ''));
  shown text := left(coalesce(nullif(new.raw_user_meta_data->>'display_name', ''), nullif(new.raw_user_meta_data->>'full_name', ''),
                              nullif(new.raw_user_meta_data->>'name', ''), split_part(coalesce(new.email, ''), '@', 1)), 60);
begin
  if wanted !~ '^[a-z0-9_]{3,30}$' then
    wanted := 'user_' || substr(replace(new.id::text, '-', ''), 1, 10);
  end if;
  begin
    insert into public.profiles (id, username, display_name) values (new.id, wanted, shown);
  exception when unique_violation then
    insert into public.profiles (id, username, display_name)
    values (new.id, 'user_' || substr(replace(new.id::text, '-', ''), 1, 10), shown);
  end;
  return new;
end $$;
revoke execute on function public.handle_new_user() from public, anon, authenticated;

-- Choose your username while setting up the account (once onboarding is finished it is fixed, as before).
create or replace function public.set_username(p_username text) returns text
language plpgsql security definer set search_path = '' as $$
declare u text := lower(btrim(coalesce(p_username, '')));
begin
  if auth.uid() is null then raise exception 'Sign in' using errcode = '28000'; end if;
  if u !~ '^[a-z0-9_]{3,30}$' then raise exception 'Use 3–30 letters, numbers or underscores' using errcode = '22023'; end if;
  if u in ('admin', 'vybe', 'support', 'help', 'root', 'staff', 'moderator', 'official', 'security', 'api', 'app', 'www') then
    raise exception 'That username is reserved' using errcode = '22023';
  end if;
  if exists (select 1 from public.profiles where id = auth.uid() and onboarded_at is not null) then
    raise exception 'Your username is set' using errcode = '42501';
  end if;
  if exists (select 1 from public.profiles where lower(username) = u and id <> auth.uid()) then
    raise exception 'That username is taken' using errcode = '23505';
  end if;
  update public.profiles set username = u where id = auth.uid();
  return u;
exception when unique_violation then
  raise exception 'That username is taken' using errcode = '23505';
end $$;
revoke execute on function public.set_username(text) from public, anon;
grant execute on function public.set_username(text) to authenticated;

-- Sign-up hint: is this username free? Usernames are public (shown on every profile); this answers yes/no only.
create or replace function public.username_available(p_username text) returns boolean
language sql stable security definer set search_path = '' as $$
  select lower(btrim(coalesce(p_username, ''))) ~ '^[a-z0-9_]{3,30}$'
     and lower(btrim(p_username)) not in ('admin', 'vybe', 'support', 'help', 'root', 'staff', 'moderator', 'official', 'security', 'api', 'app', 'www')
     and not exists (select 1 from public.profiles where lower(username) = lower(btrim(p_username)));
$$;
revoke execute on function public.username_available(text) from public;
grant execute on function public.username_available(text) to anon, authenticated;

-- ---------------------------------------------------------------- 6. sign-in throttle (Edge Function only)
create table if not exists public.login_attempts (
  id bigint generated always as identity primary key,
  ip_hash text not null check (char_length(ip_hash) between 8 and 128),
  username text not null check (char_length(username) <= 64),
  ok boolean not null,
  at timestamptz not null default now()
);
create index if not exists login_attempts_ip_idx on public.login_attempts (ip_hash, at desc);
create index if not exists login_attempts_user_idx on public.login_attempts (username, at desc);
alter table public.login_attempts enable row level security;
revoke all on public.login_attempts from anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select, insert, delete on public.login_attempts to service_role;
    grant usage on sequence public.login_attempts_id_seq to service_role;
  end if;
end $$;

-- ---------------------------------------------------------------- media read rule (migration 20 + comment video notes)
drop policy if exists media_select_visible on storage.objects;
create policy media_select_visible on storage.objects for select to authenticated
  using (
    bucket_id = 'media' and (
      (storage.foldername(objects.name))[1] = (select auth.uid())::text
      or exists (select 1 from public.posts p where p.media_path = objects.name or p.music_path = objects.name)
      or exists (select 1 from public.post_media pm where pm.path = objects.name or pm.poster_path = objects.name)
      or exists (select 1 from public.comments c where c.audio_path = objects.name or c.video_path = objects.name)
      or exists (select 1 from public.profiles pr where pr.avatar_path = objects.name or pr.cover_path = objects.name)
      or exists (select 1 from public.events e where e.cover_path = objects.name)
      or exists (select 1 from public.event_lineup l where l.image_path = objects.name)
      or exists (select 1 from public.communities c where c.cover_path = objects.name)
      or exists (select 1 from public.memories m where m.media_path = objects.name)
      or exists (select 1 from public.memory_replies r where r.audio_path = objects.name)
      or exists (select 1 from public.messages m where m.media_path = objects.name or m.audio_path = objects.name)
      or exists (select 1 from public.organizations o where o.avatar_path = objects.name or o.cover_path = objects.name)
      or exists (select 1 from public.media_assets a where a.organization_id is not null and (a.path = objects.name or a.thumb_path = objects.name))
    )
  );
