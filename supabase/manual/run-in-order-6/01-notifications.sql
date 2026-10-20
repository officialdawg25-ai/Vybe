-- Create-post upgrade, memories (stories), music, profile depth and paid verification. Additive and re-runnable.
--   * Posts get multiple media, a feeling/activity, a place, tagged friends and an attached song.
--   * Memories are 24-hour public/friends moments with views, reactions and text/voice replies (replies go to the owner only).
--   * Profiles get a cover photo, detailed sections with per-section visibility, follow/privacy settings and a paid "VYBE Verified" badge.
--   * Everything is guarded by RLS or security-definer functions that re-check who is asking.

-- ---------------------------------------------------------------- notification types
alter table public.notifications drop constraint if exists notifications_type_check;

alter table public.notifications add constraint notifications_type_check check (type in
  ('friend_request', 'friend_accepted', 'reaction', 'comment', 'event_invite', 'rsvp', 'community_join', 'new_event', 'event_update', 'event_cancelled', 'live_started',
   'post_tag', 'memory_reaction', 'memory_reply', 'verified'));

-- ---------------------------------------------------------------- profiles: cover, verification, follow/privacy settings
alter table public.profiles add column if not exists cover_path text;

alter table public.profiles add column if not exists verified_until timestamptz;

-- written only by server-side functions (payment) or an admin
alter table public.profiles add column if not exists follow_policy text not null default 'everyone' check (follow_policy in ('everyone', 'friends'));

alter table public.profiles add column if not exists show_followers text not null default 'public' check (show_followers in ('public', 'friends', 'me'));

grant update (cover_path, follow_policy, show_followers) on public.profiles to authenticated;

-- Following honours the target's follow setting.
create or replace function public.trg_follow_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare n integer; pol text;
begin
  if new.target_type = 'profile' then
    select follow_policy into pol from public.profiles where id = new.target_id;
    if not found then raise exception 'Not found'; end if;
    if public.is_blocked(new.follower, new.target_id) then raise exception 'You cannot follow this account'; end if;
    if pol = 'friends' and not public.are_friends(new.follower, new.target_id) then raise exception 'This account only accepts followers who are friends'; end if;
  elsif not exists (select 1 from public.organizations where id = new.target_id) then
    raise exception 'Not found';
  end if;
  select count(*) into n from public.follows where follower = new.follower and created_at > now() - interval '1 hour';
  if n >= 100 then raise exception 'Too many follows in a short time. Try again later.'; end if;
  return new;
end $$;

-- ---------------------------------------------------------------- music catalogue (curated by admins who hold the rights)
create table if not exists public.music_tracks (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 1 and 120),
  artist text not null check (char_length(artist) between 1 and 120),
  artwork_path text check (artwork_path is null or artwork_path ~ '^music/[0-9a-f-]{36}\.(jpg|png|webp)$'),
  preview_path text check (preview_path is null or preview_path ~ '^music/[0-9a-f-]{36}\.(mp3|m4a|ogg)$'),
  external_url text check (external_url is null or (char_length(external_url) <= 500 and external_url ~* '^https://')),
  genre text check (genre is null or char_length(genre) <= 40),
  active boolean not null default true,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists music_tracks_artist_idx on public.music_tracks (lower(artist));

alter table public.music_tracks enable row level security;
