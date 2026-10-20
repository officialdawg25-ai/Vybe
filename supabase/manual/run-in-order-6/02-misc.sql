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

revoke all on public.saved_tracks from anon, authenticated;

grant select, insert, delete on public.saved_tracks to authenticated;

-- ---------------------------------------------------------------- posts: feeling, place, song
alter table public.posts add column if not exists feeling text check (feeling is null or feeling ~ '^[a-z][a-z-]{1,24}$');

alter table public.posts add column if not exists place_name text check (place_name is null or char_length(place_name) between 1 and 120);

alter table public.posts add column if not exists place_lat double precision check (place_lat is null or place_lat between -90 and 90);

alter table public.posts add column if not exists place_lng double precision check (place_lng is null or place_lng between -180 and 180);

alter table public.posts add column if not exists music_track_id uuid references public.music_tracks(id) on delete set null;

alter table public.posts add column if not exists music_title text check (music_title is null or char_length(music_title) between 1 and 120);

alter table public.posts add column if not exists music_artist text check (music_artist is null or char_length(music_artist) between 1 and 120);

alter table public.posts add column if not exists music_url text check (music_url is null or (char_length(music_url) <= 500 and music_url ~* '^https://'));

alter table public.posts drop constraint if exists posts_place_pair;

alter table public.posts add constraint posts_place_pair check ((place_lat is null) = (place_lng is null) and (place_lat is null or place_name is not null));

create index if not exists posts_music_idx on public.posts (music_track_id, created_at desc) where music_track_id is not null;

create table if not exists public.post_media (
  post_id uuid not null references public.posts(id) on delete cascade,
  sort integer not null check (sort between 0 and 9),
  path text not null,
  type text not null check (type in ('image', 'video')),
  primary key (post_id, sort)
);

alter table public.post_media enable row level security;
