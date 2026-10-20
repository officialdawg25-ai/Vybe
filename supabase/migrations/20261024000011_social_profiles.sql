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
alter table public.profiles add column if not exists verified_until timestamptz;           -- written only by server-side functions (payment) or an admin
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
drop policy if exists post_media_read on public.post_media;
create policy post_media_read on public.post_media for select to authenticated using (exists (select 1 from public.posts p where p.id = post_id));   -- posts RLS decides
drop policy if exists post_media_ins on public.post_media;
create policy post_media_ins on public.post_media for insert to authenticated
  with check (exists (select 1 from public.posts p where p.id = post_id and p.author = auth.uid()) and path like auth.uid()::text || '/%');
drop policy if exists post_media_del on public.post_media;
create policy post_media_del on public.post_media for delete to authenticated using (exists (select 1 from public.posts p where p.id = post_id and p.author = auth.uid()));
revoke all on public.post_media from anon, authenticated;
grant select, insert, delete on public.post_media to authenticated;
-- Existing single-media posts become gallery item 0 so every reader can use one code path.
insert into public.post_media (post_id, sort, path, type) select id, 0, media_path, media_type from public.posts where media_path is not null on conflict do nothing;

create table if not exists public.post_tags (
  post_id uuid not null references public.posts(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);
create index if not exists post_tags_user_idx on public.post_tags (user_id, created_at desc);
alter table public.post_tags enable row level security;
drop policy if exists post_tags_read on public.post_tags;
create policy post_tags_read on public.post_tags for select to authenticated using (exists (select 1 from public.posts p where p.id = post_id));
drop policy if exists post_tags_ins on public.post_tags;
create policy post_tags_ins on public.post_tags for insert to authenticated
  with check (exists (select 1 from public.posts p where p.id = post_id and p.author = auth.uid()) and user_id <> auth.uid() and public.are_friends(auth.uid(), user_id));
drop policy if exists post_tags_del on public.post_tags;
create policy post_tags_del on public.post_tags for delete to authenticated
  using (user_id = auth.uid() or exists (select 1 from public.posts p where p.id = post_id and p.author = auth.uid()));   -- the tagged person can always remove the tag
revoke all on public.post_tags from anon, authenticated;
grant select, insert, delete on public.post_tags to authenticated;

create or replace function public.trg_post_tag() returns trigger
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  select count(*) into n from public.post_tags where post_id = new.post_id;
  if n >= 10 then raise exception 'You can tag up to 10 people'; end if;
  perform public.notify(new.user_id, 'post_tag', (select author from public.posts where id = new.post_id), 'post', new.post_id, 'tag:' || new.post_id || ':' || new.user_id);
  return new;
end $$;
drop trigger if exists post_tag_guard on public.post_tags;
create trigger post_tag_guard before insert on public.post_tags for each row execute function public.trg_post_tag();

-- Music picker: For you (followed artists first, then newest), Trending (most used in the last 14 days), Saved.
create or replace function public.music_catalog(p_tab text default 'foryou', p_q text default null, p_limit integer default 40) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare me uuid := auth.uid(); q text := nullif(btrim(replace(replace(coalesce(p_q, ''), '%', ''), '_', '')), ''); r jsonb;
begin
  if me is null then raise exception 'Sign in' using errcode = '28000'; end if;
  select coalesce(jsonb_agg(x.j order by x.rank1 desc, x.rank2 desc, x.created_at desc), '[]'::jsonb) into r from (
    select jsonb_build_object('id', t.id, 'title', t.title, 'artist', t.artist, 'artwork_path', t.artwork_path, 'preview_path', t.preview_path, 'external_url', t.external_url,
             'saved', exists (select 1 from public.saved_tracks s where s.user_id = me and s.track_id = t.id)) as j,
           case p_tab when 'trending' then (select count(*) from public.posts p where p.music_track_id = t.id and p.created_at > now() - interval '14 days')
                      else (case when exists (select 1 from public.follows f join public.organizations o on o.id = f.target_id and f.target_type = 'organization' where f.follower = me and lower(o.name) = lower(t.artist)) then 1 else 0 end) end as rank1,
           0 as rank2, t.created_at
    from public.music_tracks t
    where t.active and (q is null or t.title ilike '%' || q || '%' or t.artist ilike '%' || q || '%')
      and (p_tab <> 'saved' or exists (select 1 from public.saved_tracks s where s.user_id = me and s.track_id = t.id))
    order by 2 desc, t.created_at desc
    limit least(greatest(p_limit, 1), 100)
  ) x;
  return r;
end $$;

-- ---------------------------------------------------------------- memories (24-hour moments)
create table if not exists public.memories (
  id uuid primary key default gen_random_uuid(),
  author uuid not null references public.profiles(id) on delete cascade,
  kind text not null check (kind in ('photo', 'video', 'text')),
  media_path text,
  text_body text not null default '' check (char_length(text_body) <= 500),
  bg text not null default 'violet' check (bg in ('violet', 'teal', 'rose', 'sun', 'night', 'ocean')),
  visibility text not null default 'friends' check (visibility in ('public', 'friends')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '24 hours',
  highlight boolean not null default false,
  highlight_title text check (highlight_title is null or char_length(highlight_title) <= 40),
  check ((kind = 'text') = (media_path is null)),
  check (kind <> 'text' or btrim(text_body) <> ''),
  check (media_path is null or media_path like author::text || '/%')
);
create index if not exists memories_author_idx on public.memories (author, created_at desc);
create index if not exists memories_active_idx on public.memories (expires_at desc);
alter table public.memories enable row level security;

create or replace function public.can_view_memory(m public.memories) returns boolean
language sql stable security definer set search_path = '' as $$
  select m.author = auth.uid() or (
    not public.is_blocked(auth.uid(), m.author)
    and (m.expires_at > now() or m.highlight)
    and (m.visibility = 'public' or (m.visibility = 'friends' and public.are_friends(auth.uid(), m.author)))
  );
$$;
create or replace function public.can_view_memory_id(mid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select public.can_view_memory(m) from public.memories m where m.id = mid), false);
$$;
-- Replies behave like messages: they respect the owner's "who can message me" setting.
create or replace function public.can_reply_memory(mid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select public.can_view_memory(m) and m.author <> auth.uid() and m.expires_at > now()
                          and (p.dm_policy = 'everyone' or public.are_friends(auth.uid(), m.author))
                   from public.memories m join public.profiles p on p.id = m.author where m.id = mid), false);
$$;
drop policy if exists memories_read on public.memories;
create policy memories_read on public.memories for select to authenticated using (public.can_view_memory(memories));
drop policy if exists memories_ins on public.memories;
create policy memories_ins on public.memories for insert to authenticated with check (author = auth.uid());
drop policy if exists memories_upd on public.memories;
create policy memories_upd on public.memories for update to authenticated using (author = auth.uid()) with check (author = auth.uid());
drop policy if exists memories_del on public.memories;
create policy memories_del on public.memories for delete to authenticated using (author = auth.uid());
revoke all on public.memories from anon, authenticated;
grant select, delete on public.memories to authenticated;
grant insert (author, kind, media_path, text_body, bg, visibility) on public.memories to authenticated;
grant update (visibility, highlight, highlight_title) on public.memories to authenticated;

create or replace function public.trg_memory_limit() returns trigger
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  select count(*) into n from public.memories where author = new.author and created_at > now() - interval '24 hours';
  if n >= 40 then raise exception 'You have shared a lot of memories today. Try again tomorrow.'; end if;
  return new;
end $$;
drop trigger if exists memory_limit on public.memories;
create trigger memory_limit before insert on public.memories for each row execute function public.trg_memory_limit();

create table if not exists public.memory_views (
  memory_id uuid not null references public.memories(id) on delete cascade,
  viewer uuid not null references public.profiles(id) on delete cascade,
  viewed_at timestamptz not null default now(),
  primary key (memory_id, viewer)
);
alter table public.memory_views enable row level security;
drop policy if exists memory_views_read on public.memory_views;
create policy memory_views_read on public.memory_views for select to authenticated
  using (viewer = auth.uid() or exists (select 1 from public.memories m where m.id = memory_id and m.author = auth.uid()));
drop policy if exists memory_views_ins on public.memory_views;
create policy memory_views_ins on public.memory_views for insert to authenticated with check (viewer = auth.uid() and public.can_view_memory_id(memory_id));
revoke all on public.memory_views from anon, authenticated;
grant select, insert on public.memory_views to authenticated;

create table if not exists public.memory_reactions (
  memory_id uuid not null references public.memories(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  emoji text not null check (emoji in ('heart', 'like', 'laugh', 'wow', 'sad', 'fire')),
  created_at timestamptz not null default now(),
  primary key (memory_id, user_id)
);
alter table public.memory_reactions enable row level security;
drop policy if exists memory_reactions_read on public.memory_reactions;
create policy memory_reactions_read on public.memory_reactions for select to authenticated
  using (user_id = auth.uid() or exists (select 1 from public.memories m where m.id = memory_id and m.author = auth.uid()));
drop policy if exists memory_reactions_ins on public.memory_reactions;
create policy memory_reactions_ins on public.memory_reactions for insert to authenticated with check (user_id = auth.uid() and public.can_view_memory_id(memory_id));
drop policy if exists memory_reactions_upd on public.memory_reactions;
create policy memory_reactions_upd on public.memory_reactions for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists memory_reactions_del on public.memory_reactions;
create policy memory_reactions_del on public.memory_reactions for delete to authenticated using (user_id = auth.uid());
revoke all on public.memory_reactions from anon, authenticated;
grant select, insert, delete on public.memory_reactions to authenticated;
grant update (emoji) on public.memory_reactions to authenticated;

create or replace function public.trg_memory_reaction() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform public.notify((select author from public.memories where id = new.memory_id), 'memory_reaction', new.user_id, 'memory', new.memory_id, 'mr:' || new.memory_id || ':' || new.user_id);
  return new;
end $$;
drop trigger if exists memory_reaction_notify on public.memory_reactions;
create trigger memory_reaction_notify after insert on public.memory_reactions for each row execute function public.trg_memory_reaction();

create table if not exists public.memory_replies (
  id uuid primary key default gen_random_uuid(),
  memory_id uuid not null references public.memories(id) on delete cascade,
  author uuid not null references public.profiles(id) on delete cascade,
  body text not null default '' check (char_length(body) <= 500),
  audio_path text,
  audio_ms integer check (audio_ms is null or audio_ms between 500 and 61000),
  created_at timestamptz not null default now(),
  check (btrim(body) <> '' or audio_path is not null),
  check ((audio_path is null) = (audio_ms is null)),
  check (audio_path is null or audio_path like author::text || '/%')
);
create index if not exists memory_replies_memory_idx on public.memory_replies (memory_id, created_at);
alter table public.memory_replies enable row level security;
drop policy if exists memory_replies_read on public.memory_replies;
create policy memory_replies_read on public.memory_replies for select to authenticated
  using (author = auth.uid() or exists (select 1 from public.memories m where m.id = memory_id and m.author = auth.uid()));
drop policy if exists memory_replies_ins on public.memory_replies;
create policy memory_replies_ins on public.memory_replies for insert to authenticated with check (author = auth.uid() and public.can_reply_memory(memory_id));
drop policy if exists memory_replies_del on public.memory_replies;
create policy memory_replies_del on public.memory_replies for delete to authenticated using (author = auth.uid());
revoke all on public.memory_replies from anon, authenticated;
grant select, delete on public.memory_replies to authenticated;
grant insert (memory_id, author, body, audio_path, audio_ms) on public.memory_replies to authenticated;

create or replace function public.trg_memory_reply() returns trigger
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  select count(*) into n from public.memory_replies where author = new.author and created_at > now() - interval '1 hour';
  if n >= 30 then raise exception 'Slow down a little.'; end if;
  perform public.notify((select author from public.memories where id = new.memory_id), 'memory_reply', new.author, 'memory', new.memory_id, 'rp:' || new.id);
  return new;
end $$;
drop trigger if exists memory_reply_guard on public.memory_replies;
create trigger memory_reply_guard before insert on public.memory_replies for each row execute function public.trg_memory_reply();

-- Rail: people with a live memory you may see — friends first, unseen first. Aggregates + a cover only.
create or replace function public.memory_rail(p_limit integer default 30) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare me uuid := auth.uid(); r jsonb;
begin
  if me is null then raise exception 'Sign in' using errcode = '28000'; end if;
  with vis as (
    select m.* from public.memories m where m.author <> me and m.expires_at > now() and public.can_view_memory(m)
  ), by_author as (
    select v.author, count(*) as n, max(v.created_at) as latest,
           count(*) filter (where not exists (select 1 from public.memory_views mv where mv.memory_id = v.id and mv.viewer = me)) as unseen
    from vis v group by v.author
  ), ranked as (
    select b.*, public.are_friends(me, b.author) as friend from by_author b order by (b.unseen > 0) desc, public.are_friends(me, b.author) desc, b.latest desc
    limit least(greatest(p_limit, 1), 60)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'author', (select jsonb_build_object('id', p.id, 'username', p.username, 'display_name', p.display_name, 'avatar_path', p.avatar_path, 'verified_until', p.verified_until) from public.profiles p where p.id = ra.author),
    'count', ra.n, 'unseen', ra.unseen, 'latest_at', ra.latest, 'friend', ra.friend,
    'cover', (select jsonb_build_object('kind', v.kind, 'media_path', v.media_path, 'text_body', v.text_body, 'bg', v.bg) from vis v where v.author = ra.author order by v.created_at desc limit 1)
  ) order by (ra.unseen > 0) desc, ra.friend desc, ra.latest desc), '[]'::jsonb) into r from ranked ra;
  return r;
end $$;

-- One person's memories in order. For the owner it also returns the counts they are allowed to see.
create or replace function public.author_memories(p_author uuid, p_highlights boolean default false) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare me uuid := auth.uid(); r jsonb;
begin
  if me is null then raise exception 'Sign in' using errcode = '28000'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', m.id, 'kind', m.kind, 'media_path', m.media_path, 'text_body', m.text_body, 'bg', m.bg, 'created_at', m.created_at, 'expires_at', m.expires_at,
    'visibility', m.visibility, 'highlight', m.highlight, 'highlight_title', m.highlight_title,
    'mine_reaction', (select emoji from public.memory_reactions x where x.memory_id = m.id and x.user_id = me),
    'seen', exists (select 1 from public.memory_views v where v.memory_id = m.id and v.viewer = me),
    'views', case when m.author = me then (select count(*) from public.memory_views v where v.memory_id = m.id) end,
    'reactions', case when m.author = me then (select count(*) from public.memory_reactions x where x.memory_id = m.id) end,
    'replies', case when m.author = me then (select count(*) from public.memory_replies y where y.memory_id = m.id) end
  ) order by m.created_at), '[]'::jsonb) into r
  from public.memories m
  where m.author = p_author and public.can_view_memory(m)
    and ((p_highlights and m.highlight) or (not p_highlights and m.expires_at > now()));
  return r;
end $$;

-- Messages can carry a photo/video or a voice note (stored in the private media bucket under the sender's folder).
alter table public.messages drop constraint if exists messages_body_check;
alter table public.messages drop constraint if exists messages_body_len;
alter table public.messages add constraint messages_body_len check (char_length(body) <= 4000);
alter table public.messages add column if not exists media_path text;
alter table public.messages add column if not exists media_type text check (media_type is null or media_type in ('image', 'video'));
alter table public.messages add column if not exists audio_path text;
alter table public.messages add column if not exists audio_ms integer check (audio_ms is null or audio_ms between 500 and 61000);
alter table public.messages drop constraint if exists messages_has_content;
alter table public.messages add constraint messages_has_content check (btrim(body) <> '' or media_path is not null or audio_path is not null or deleted_at is not null);
alter table public.messages drop constraint if exists messages_media_pair;
alter table public.messages add constraint messages_media_pair check ((media_path is null) = (media_type is null) and (audio_path is null) = (audio_ms is null));
drop policy if exists messages_insert on public.messages;
create policy messages_insert on public.messages for insert to authenticated
  with check (sender = auth.uid() and public.is_conversation_member(conversation_id)
    and (media_path is null or media_path like auth.uid()::text || '/%') and (audio_path is null or audio_path like auth.uid()::text || '/%'));

-- Media for memories and the extra post media/cover photos is readable exactly where the row is readable.
drop policy if exists media_select_visible on storage.objects;
create policy media_select_visible on storage.objects for select to authenticated
  using (
    bucket_id = 'media' and (
      (storage.foldername(name))[1] = auth.uid()::text
      or exists (select 1 from public.posts p where p.media_path = name)
      or exists (select 1 from public.post_media pm where pm.path = name)
      or exists (select 1 from public.comments c where c.audio_path = name)
      or exists (select 1 from public.profiles pr where pr.avatar_path = name or pr.cover_path = name)
      or exists (select 1 from public.events e where e.cover_path = name)
      or exists (select 1 from public.event_lineup l where l.image_path = name)
      or exists (select 1 from public.communities c where c.cover_path = name)
      or exists (select 1 from public.memories m where m.media_path = name)
      or exists (select 1 from public.memory_replies r where r.audio_path = name)
      or exists (select 1 from public.messages m where m.media_path = name or m.audio_path = name)
    )
  );

-- Music artwork and previews go in the public `brand` bucket under music/ (admins only), like hero and promo media.
update storage.buckets set allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm', 'audio/mpeg', 'audio/mp4', 'audio/ogg'] where id = 'brand';
drop policy if exists brand_admin_insert on storage.objects;
create policy brand_admin_insert on storage.objects for insert to authenticated
  with check (bucket_id in ('brand', 'brand-draft') and public.is_admin()
    and (name ~ '^(hero|promo)/[0-9a-f-]{36}\.(jpg|png|webp|mp4|webm)$' or name ~ '^music/[0-9a-f-]{36}\.(jpg|png|webp|mp3|m4a|ogg)$'));

-- ---------------------------------------------------------------- profile details (per-section visibility)
create table if not exists public.profile_details (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  about text not null default '' check (char_length(about) <= 500),
  current_city text check (current_city is null or char_length(current_city) <= 80),
  hometown text check (hometown is null or char_length(hometown) <= 80),
  relationship text check (relationship is null or relationship in ('single', 'in_a_relationship', 'engaged', 'married', 'complicated', 'prefer_not')),
  gender text check (gender is null or gender in ('male', 'female', 'nonbinary', 'prefer_not')),
  birthday_visible boolean not null default false,
  languages text[] not null default '{}' check (cardinality(languages) <= 8),
  education jsonb not null default '[]' check (jsonb_typeof(education) = 'array' and jsonb_array_length(education) <= 5),
  work jsonb not null default '[]' check (jsonb_typeof(work) = 'array' and jsonb_array_length(work) <= 5),
  hobbies text[] not null default '{}' check (cardinality(hobbies) <= 12),
  travel text[] not null default '{}' check (cardinality(travel) <= 20),
  links jsonb not null default '[]' check (jsonb_typeof(links) = 'array' and jsonb_array_length(links) <= 5),
  contact jsonb not null default '{}' check (jsonb_typeof(contact) = 'object'),
  visibility jsonb not null default '{"about":"public","personal":"public","work":"public","education":"public","hobbies":"public","travel":"public","links":"public","contact":"friends"}',
  updated_at timestamptz not null default now()
);
alter table public.profile_details enable row level security;
drop policy if exists profile_details_own on public.profile_details;
create policy profile_details_own on public.profile_details for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
revoke all on public.profile_details from anon, authenticated;
grant select, insert, update on public.profile_details to authenticated;

-- Validates the free-form parts so nothing unsafe or oversized is stored (links must be https, visibility values fixed).
create or replace function public.trg_profile_details_check() returns trigger
language plpgsql set search_path = '' as $$
declare e jsonb; k text; v text;
begin
  for e in select * from jsonb_array_elements(new.links) loop
    if jsonb_typeof(e) <> 'object' or coalesce(e ->> 'url', '') !~* '^https://[^\s]{3,255}$' or char_length(coalesce(e ->> 'label', '')) > 40 then raise exception 'Links must start with https://'; end if;
  end loop;
  for e in select * from jsonb_array_elements(new.education) loop
    if jsonb_typeof(e) <> 'object' or char_length(coalesce(e ->> 'school', '')) not between 1 and 120 or char_length(coalesce(e ->> 'field', '')) > 120 then raise exception 'Check your education entries'; end if;
  end loop;
  for e in select * from jsonb_array_elements(new.work) loop
    if jsonb_typeof(e) <> 'object' or char_length(coalesce(e ->> 'employer', '')) not between 1 and 120 or char_length(coalesce(e ->> 'role', '')) > 120 then raise exception 'Check your work entries'; end if;
  end loop;
  if (select count(*) from jsonb_object_keys(new.contact)) > 6 then raise exception 'Too many contact fields'; end if;
  for k, v in select key, value from jsonb_each_text(new.contact) loop
    if char_length(v) > 120 then raise exception 'Contact details are too long'; end if;
  end loop;
  for k, v in select key, value from jsonb_each_text(new.visibility) loop
    if v not in ('public', 'friends', 'me') or k not in ('about', 'personal', 'work', 'education', 'hobbies', 'travel', 'links', 'contact') then raise exception 'Invalid visibility'; end if;
  end loop;
  if exists (select 1 from unnest(new.hobbies || new.travel || new.languages) x where char_length(x) not between 1 and 40) then raise exception 'Entries must be 1 to 40 characters'; end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists profile_details_check on public.profile_details;
create trigger profile_details_check before insert or update on public.profile_details for each row execute function public.trg_profile_details_check();

-- The only way anyone else reads details: sections come back only if their visibility allows this viewer.
-- p_as lets the OWNER preview their profile as 'public' or as a 'friend' ("View as").
create or replace function public.get_profile_details(p_user uuid, p_as text default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare me uuid := auth.uid(); d public.profile_details; lvl integer; bd date; r jsonb := '{}'::jsonb;
  sect text; allowed boolean;
begin
  if me is null then raise exception 'Sign in' using errcode = '28000'; end if;
  if me <> p_user and public.is_blocked(me, p_user) then return null; end if;
  -- viewer level: 3 = me, 2 = friend, 1 = anyone
  lvl := case when me = p_user then 3 when public.are_friends(me, p_user) then 2 else 1 end;
  if me = p_user and p_as = 'public' then lvl := 1; elsif me = p_user and p_as = 'friend' then lvl := 2; end if;
  select * into d from public.profile_details where user_id = p_user;
  if not found then return jsonb_build_object('level', lvl); end if;
  select birth_date into bd from public.profile_private where user_id = p_user;
  r := jsonb_build_object('level', lvl);
  foreach sect in array array['about', 'personal', 'work', 'education', 'hobbies', 'travel', 'links', 'contact'] loop
    allowed := lvl = 3 and p_as is null
      or (d.visibility ->> sect) = 'public'
      or ((d.visibility ->> sect) = 'friends' and lvl >= 2);
    if not allowed then continue; end if;
    r := r || case sect
      when 'about' then jsonb_build_object('about', d.about)
      when 'personal' then jsonb_build_object('personal', jsonb_build_object('current_city', d.current_city, 'hometown', d.hometown, 'relationship', d.relationship,
                             'gender', case when lvl = 3 and p_as is null then d.gender end, 'languages', to_jsonb(d.languages),
                             'birthday', case when d.birthday_visible and bd is not null then to_char(bd, 'FMDD FMMonth') end))
      when 'work' then jsonb_build_object('work', d.work)
      when 'education' then jsonb_build_object('education', d.education)
      when 'hobbies' then jsonb_build_object('hobbies', to_jsonb(d.hobbies))
      when 'travel' then jsonb_build_object('travel', to_jsonb(d.travel))
      when 'links' then jsonb_build_object('links', d.links)
      else jsonb_build_object('contact', d.contact)
    end;
  end loop;
  return r;
end $$;

-- Counts for the profile header. Followers/following obey the owner's setting; friends is always shown to people who can see the profile.
-- posts = how many posts the VIEWER may see. follows_me powers "Follows you" / "Follow back".
create or replace function public.profile_stats(p_user uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare me uuid := auth.uid(); pol text; show_f boolean;
begin
  if me is null then raise exception 'Sign in' using errcode = '28000'; end if;
  if me <> p_user and public.is_blocked(me, p_user) then return null; end if;
  select show_followers into pol from public.profiles where id = p_user;
  show_f := me = p_user or pol = 'public' or (pol = 'friends' and public.are_friends(me, p_user));
  return jsonb_build_object(
    'friends', (select count(*) from public.friendships where status = 'accepted' and (requester = p_user or addressee = p_user)),
    'posts', (select count(*) from public.posts p where p.author = p_user and public.can_view_post(p)),
    'followers', case when show_f then (select count(*) from public.follows where target_type = 'profile' and target_id = p_user) end,
    'following', case when show_f then (select count(*) from public.follows where follower = p_user) end,
    'i_follow', exists (select 1 from public.follows where follower = me and target_type = 'profile' and target_id = p_user),
    'follows_me', exists (select 1 from public.follows where follower = p_user and target_type = 'profile' and target_id = me));
end $$;

-- "Followed by A, B and 6 others": people who follow this account and are also your friends or accounts you follow. Names and counts only.
create or replace function public.profile_followed_by(p_user uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare me uuid := auth.uid(); r jsonb;
begin
  if me is null then raise exception 'Sign in' using errcode = '28000'; end if;
  if me = p_user or public.is_blocked(me, p_user) then return jsonb_build_object('count', 0, 'people', '[]'::jsonb); end if;
  with common as (
    select f.follower as id from public.follows f
    where f.target_type = 'profile' and f.target_id = p_user and f.follower <> me
      and (public.are_friends(me, f.follower) or exists (select 1 from public.follows mine where mine.follower = me and mine.target_type = 'profile' and mine.target_id = f.follower))
      and not public.is_blocked(me, f.follower)
  )
  select jsonb_build_object('count', (select count(*) from common),
    'people', coalesce((select jsonb_agg(jsonb_build_object('username', p.username, 'display_name', p.display_name, 'avatar_path', p.avatar_path))
                        from (select pr.username, pr.display_name, pr.avatar_path from common c join public.profiles pr on pr.id = c.id order by pr.username limit 3) p), '[]'::jsonb)) into r;
  return r;
end $$;

-- Discover people: accounts you do not follow yet, "Follow back" first, then most friends in common, then most shared interests.
create or replace function public.people_suggestions(p_limit integer default 40) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare me uuid := auth.uid(); r jsonb; mine text[];
begin
  if me is null then raise exception 'Sign in' using errcode = '28000'; end if;
  select interests into mine from public.profiles where id = me;
  select coalesce(jsonb_agg(x.j order by x.fb desc, x.mutual desc, x.shared desc, x.created_at desc), '[]'::jsonb) into r from (
    select jsonb_build_object('id', p.id, 'username', p.username, 'display_name', p.display_name, 'avatar_path', p.avatar_path, 'verified_until', p.verified_until,
             'follows_me', fm.v, 'friend', public.are_friends(me, p.id), 'mutual', mu.n, 'shared', to_jsonb(sh.arr)) as j,
           fm.v as fb, mu.n as mutual, coalesce(cardinality(sh.arr), 0) as shared, p.created_at
    from public.profiles p
    cross join lateral (select exists (select 1 from public.follows f where f.follower = p.id and f.target_type = 'profile' and f.target_id = me) as v) fm
    cross join lateral (select count(*) as n from public.friendships a join public.friendships b
        on ((a.requester = me and a.addressee = case when b.requester = p.id then b.addressee else b.requester end) or (a.addressee = me and a.requester = case when b.requester = p.id then b.addressee else b.requester end))
       where a.status = 'accepted' and b.status = 'accepted' and (b.requester = p.id or b.addressee = p.id)) mu
    cross join lateral (select array(select i from unnest(p.interests) i where i = any (coalesce(mine, '{}'))) as arr) sh
    where p.id <> me and not public.is_blocked(me, p.id)
      and not exists (select 1 from public.follows f where f.follower = me and f.target_type = 'profile' and f.target_id = p.id)
      and (p.follow_policy = 'everyone' or public.are_friends(me, p.id))
    order by fm.v desc, mu.n desc, coalesce(cardinality(sh.arr), 0) desc, p.created_at desc
    limit least(greatest(p_limit, 1), 100)
  ) x;
  return r;
end $$;

-- ---------------------------------------------------------------- VYBE Verified (paid badge)
create table if not exists public.verification_plans (
  id text primary key check (id ~ '^[a-z0-9_-]{3,20}$'),
  label text not null check (char_length(label) between 3 and 60),
  days integer not null check (days between 1 and 3660),
  price_cents integer not null check (price_cents >= 100),
  active boolean not null default true,
  sort integer not null default 100
);
alter table public.verification_plans enable row level security;
drop policy if exists verification_plans_read on public.verification_plans;
create policy verification_plans_read on public.verification_plans for select to authenticated using (active or public.is_admin());
drop policy if exists verification_plans_admin on public.verification_plans;
create policy verification_plans_admin on public.verification_plans for all to authenticated using (public.is_admin()) with check (public.is_admin());
revoke all on public.verification_plans from anon, authenticated;
grant select, insert, update, delete on public.verification_plans to authenticated;
-- Starting prices only: administrators set the real ones in Admin → Verification.
insert into public.verification_plans (id, label, days, price_cents, sort) values
  ('monthly', 'VYBE Verified · 1 month', 30, 4900, 10), ('yearly', 'VYBE Verified · 1 year', 365, 49900, 20)
on conflict (id) do nothing;

create table if not exists public.badge_orders (
  id uuid primary key default gen_random_uuid(),
  buyer uuid not null references public.profiles(id) on delete restrict,
  plan_id text not null references public.verification_plans(id),
  days integer not null,
  total_cents bigint not null check (total_cents >= 100),
  provider text not null check (provider in ('payfast', 'ozow')),
  provider_ref text,
  status text not null default 'pending' check (status in ('pending', 'paid', 'failed', 'cancelled', 'expired')),
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 80),
  ip_hash text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  paid_at timestamptz,
  unique (buyer, idempotency_key)
);
create unique index if not exists badge_orders_ref_key on public.badge_orders (provider, provider_ref) where provider_ref is not null;
create index if not exists badge_orders_buyer_idx on public.badge_orders (buyer, created_at desc);
alter table public.badge_orders enable row level security;
drop policy if exists badge_orders_own on public.badge_orders;
create policy badge_orders_own on public.badge_orders for select to authenticated using (buyer = auth.uid() or public.is_admin());
revoke all on public.badge_orders from anon, authenticated;
grant select on public.badge_orders to authenticated;

-- Priced from verification_plans on the server; the browser sends only a plan id. Idempotent per (buyer, key).
create or replace function public.create_badge_order(p_plan text, p_provider text, p_idem text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid(); pl public.verification_plans; pr public.profiles; o public.badge_orders; recent integer;
begin
  if me is null then raise exception 'Sign in' using errcode = '28000'; end if;
  if p_provider not in ('payfast', 'ozow') then raise exception 'Choose PayFast or Ozow'; end if;
  select * into o from public.badge_orders where buyer = me and idempotency_key = p_idem;
  if found then return jsonb_build_object('id', o.id, 'status', o.status, 'total_cents', o.total_cents, 'expires_at', o.expires_at); end if;
  select * into pl from public.verification_plans where id = p_plan and active;
  if not found then raise exception 'That plan is not available'; end if;
  select * into pr from public.profiles where id = me;
  if coalesce(btrim(pr.display_name), '') = '' or pr.avatar_path is null then raise exception 'Add a profile photo and your name before applying for the badge'; end if;
  select count(*) into recent from public.badge_orders where buyer = me and created_at > now() - interval '1 hour';
  if recent >= 5 then raise exception 'Too many attempts. Please wait a while.'; end if;
  insert into public.badge_orders (buyer, plan_id, days, total_cents, provider, idempotency_key, expires_at)
  values (me, pl.id, pl.days, pl.price_cents, p_provider, p_idem, now() + interval '30 minutes') returning * into o;
  return jsonb_build_object('id', o.id, 'status', o.status, 'total_cents', o.total_cents, 'expires_at', o.expires_at);
end $$;

-- Service role only (payment webhooks). Idempotent; amount and provider must match what we priced.
create or replace function public.fulfill_badge_order(p_order uuid, p_provider text, p_ref text, p_amount_cents bigint) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.badge_orders;
begin
  select * into o from public.badge_orders where id = p_order for update;
  if not found then raise exception 'Order not found'; end if;
  if o.status = 'paid' then return; end if;
  if o.provider <> p_provider then raise exception 'Provider mismatch'; end if;
  if o.total_cents <> p_amount_cents then raise exception 'Amount mismatch'; end if;
  update public.badge_orders set status = 'paid', provider_ref = p_ref, paid_at = now() where id = o.id;
  update public.profiles set verified_until = greatest(now(), coalesce(verified_until, now())) + make_interval(days => o.days) where id = o.buyer;
  insert into public.audit_log (actor, action, entity_type, entity_id, detail) values (null, 'verified.paid', 'profile', o.buyer, jsonb_build_object('order', o.id, 'days', o.days, 'cents', o.total_cents));
  perform public.notify(o.buyer, 'verified', null, 'profile', o.buyer, 'vf:' || o.id);
end $$;
create or replace function public.close_badge_order(p_order uuid, p_status text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_status not in ('failed', 'cancelled', 'expired') then raise exception 'bad status'; end if;
  update public.badge_orders set status = p_status where id = p_order and status = 'pending';
end $$;
create or replace function public.admin_set_verified(p_user uuid, p_until timestamptz) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.profiles set verified_until = p_until where id = p_user;
  insert into public.audit_log (actor, action, entity_type, entity_id, detail) values (auth.uid(), 'verified.admin_set', 'profile', p_user, jsonb_build_object('until', p_until));
end $$;

revoke execute on function public.profile_followed_by(uuid), public.people_suggestions(integer) from public, anon;
grant execute on function public.profile_followed_by(uuid), public.people_suggestions(integer) to authenticated;
revoke execute on function public.music_catalog(text, text, integer), public.memory_rail(integer), public.author_memories(uuid, boolean), public.get_profile_details(uuid, text),
  public.profile_stats(uuid), public.create_badge_order(text, text, text), public.admin_set_verified(uuid, timestamptz), public.can_view_memory_id(uuid), public.can_reply_memory(uuid),
  public.fulfill_badge_order(uuid, text, text, bigint), public.close_badge_order(uuid, text) from public, anon;
grant execute on function public.music_catalog(text, text, integer), public.memory_rail(integer), public.author_memories(uuid, boolean), public.get_profile_details(uuid, text),
  public.profile_stats(uuid), public.create_badge_order(text, text, text), public.admin_set_verified(uuid, timestamptz), public.can_view_memory_id(uuid), public.can_reply_memory(uuid) to authenticated;
revoke execute on function public.fulfill_badge_order(uuid, text, text, bigint), public.close_badge_order(uuid, text) from authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.fulfill_badge_order(uuid, text, text, bigint), public.close_badge_order(uuid, text) to service_role;
  end if;
end $$;
