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

drop policy if exists post_media_read on public.post_media;

create policy post_media_read on public.post_media for select to authenticated using (exists (select 1 from public.posts p where p.id = post_id));

-- posts RLS decides
drop policy if exists post_media_ins on public.post_media;

create policy post_media_ins on public.post_media for insert to authenticated
  with check (exists (select 1 from public.posts p where p.id = post_id and p.author = auth.uid()) and path like auth.uid()::text || '/%');

drop policy if exists post_media_del on public.post_media;

create policy post_media_del on public.post_media for delete to authenticated using (exists (select 1 from public.posts p where p.id = post_id and p.author = auth.uid()));

revoke all on public.post_media from anon, authenticated;

grant select, insert, delete on public.post_media to authenticated;

-- Existing single-media posts become gallery item 0 so every reader can use one code path.
insert into public.post_media (post_id, sort, path, type) select id, 0, media_path, media_type from public.posts where media_path is not null on conflict do nothing;
