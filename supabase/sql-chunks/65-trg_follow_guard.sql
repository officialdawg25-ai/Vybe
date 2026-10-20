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

drop policy if exists music_read on public.music_tracks;

create policy music_read on public.music_tracks for select to authenticated using (active or public.is_admin());

drop policy if exists music_admin on public.music_tracks;

create policy music_admin on public.music_tracks for all to authenticated using (public.is_admin()) with check (public.is_admin());

revoke all on public.music_tracks from anon, authenticated;

grant select, insert, update, delete on public.music_tracks to authenticated;

create table if not exists public.saved_tracks (
  user_id uuid not null references public.profiles(id) on delete cascade,
  track_id uuid not null references public.music_tracks(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, track_id)
);

alter table public.saved_tracks enable row level security;

drop policy if exists saved_tracks_own on public.saved_tracks;

create policy saved_tracks_own on public.saved_tracks for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
