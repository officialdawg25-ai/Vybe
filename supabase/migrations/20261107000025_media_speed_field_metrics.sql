-- Migration 25: faster media permission checks, photo display copies, and field performance numbers. Additive and
-- re-runnable; no existing row is rewritten.
--
-- 1. Indexes for every file-path column the `media` read policy looks up. Storage evaluates that policy for each file it
--    signs; without these, each check scanned posts, post_media, comments and more in full (an author picture scans all of
--    them before reaching profiles). Measured on a copy with 40k posts: signing check for a 20-file feed page
--    174 ms -> 4.9 ms, and it no longer grows with the tables.
-- 2. post_media.display_path: the phone-sized WebP copy of a photo (at most 1080 px wide) made on the uploader's device.
--    Feeds show it; the original stays untouched for full quality. Same rules as poster_path: only in the author's own
--    folder, readable exactly when the post's media is.
-- 3. client_metrics: anonymous performance numbers from real devices (Web Vitals, time to first post, reel start-up,
--    live first frame). Numbers and coarse buckets only: no user id, no URLs, no content. Written only through
--    record_client_metrics (signed-in, at most 30 samples a call, 300 a day per person, kept 30 days); read only by
--    admins as percentiles through client_metrics_summary.
--
-- Rollback: drop the indexes below; alter table public.post_media drop column display_path (after re-running the
-- media_select_visible block from migration 23 and post_media_ins from migration 20); drop table public.client_metrics,
-- public.client_metric_quota; drop function public.record_client_metrics(jsonb), public.client_metrics_summary(integer).

-- ---------------------------------------------------------------- 1. path indexes
create index if not exists posts_media_path_idx on public.posts (media_path) where media_path is not null;
create index if not exists posts_music_path_idx on public.posts (music_path) where music_path is not null;
create index if not exists post_media_path_idx on public.post_media (path);
create index if not exists post_media_poster_path_idx on public.post_media (poster_path) where poster_path is not null;
create index if not exists comments_audio_path_idx on public.comments (audio_path) where audio_path is not null;
create index if not exists comments_video_path_idx on public.comments (video_path) where video_path is not null;
create index if not exists profiles_avatar_path_idx on public.profiles (avatar_path) where avatar_path is not null;
create index if not exists profiles_cover_path_idx on public.profiles (cover_path) where cover_path is not null;
create index if not exists events_cover_path_idx on public.events (cover_path) where cover_path is not null;
create index if not exists events_hero_video_path_idx on public.events (hero_video_path) where hero_video_path is not null;
create index if not exists event_lineup_image_path_idx on public.event_lineup (image_path) where image_path is not null;
create index if not exists communities_cover_path_idx on public.communities (cover_path) where cover_path is not null;
create index if not exists memories_media_path_idx on public.memories (media_path) where media_path is not null;
create index if not exists memory_replies_audio_path_idx on public.memory_replies (audio_path) where audio_path is not null;
create index if not exists messages_media_path_idx on public.messages (media_path) where media_path is not null;
create index if not exists messages_audio_path_idx on public.messages (audio_path) where audio_path is not null;
create index if not exists messages_file_path_idx on public.messages (file_path) where file_path is not null;
create index if not exists organizations_avatar_path_idx on public.organizations (avatar_path) where avatar_path is not null;
create index if not exists organizations_cover_path_idx on public.organizations (cover_path) where cover_path is not null;
create index if not exists media_assets_org_path_idx on public.media_assets (path) where organization_id is not null;
create index if not exists media_assets_org_thumb_path_idx on public.media_assets (thumb_path) where organization_id is not null and thumb_path is not null;

-- ---------------------------------------------------------------- 2. photo display copies
alter table public.post_media add column if not exists display_path text;
create index if not exists post_media_display_path_idx on public.post_media (display_path) where display_path is not null;
drop policy if exists post_media_ins on public.post_media;
create policy post_media_ins on public.post_media for insert to authenticated
  with check (exists (select 1 from public.posts p where p.id = post_id and p.author = (select auth.uid()))
              and path like (select auth.uid())::text || '/%'
              and (poster_path is null or poster_path like (select auth.uid())::text || '/%')
              and (display_path is null or (type = 'image' and display_path like (select auth.uid())::text || '/%')));

-- Migration 23's rule, plus display copies.
drop policy if exists media_select_visible on storage.objects;
create policy media_select_visible on storage.objects for select to authenticated
  using (
    bucket_id = 'media' and (
      (storage.foldername(objects.name))[1] = (select auth.uid())::text
      or exists (select 1 from public.posts p where p.media_path = objects.name or p.music_path = objects.name)
      or exists (select 1 from public.post_media pm where pm.path = objects.name or pm.poster_path = objects.name or pm.display_path = objects.name)
      or exists (select 1 from public.comments c where c.audio_path = objects.name or c.video_path = objects.name)
      or exists (select 1 from public.profiles pr where pr.avatar_path = objects.name or pr.cover_path = objects.name)
      or exists (select 1 from public.events e where e.cover_path = objects.name or e.hero_video_path = objects.name)
      or exists (select 1 from public.event_lineup l where l.image_path = objects.name)
      or exists (select 1 from public.communities c where c.cover_path = objects.name)
      or exists (select 1 from public.memories m where m.media_path = objects.name)
      or exists (select 1 from public.memory_replies r where r.audio_path = objects.name)
      or exists (select 1 from public.messages m where m.media_path = objects.name or m.audio_path = objects.name)
      or exists (select 1 from public.organizations o where o.avatar_path = objects.name or o.cover_path = objects.name)
      or exists (select 1 from public.media_assets a where a.organization_id is not null and (a.path = objects.name or a.thumb_path = objects.name))
    )
  );

-- ---------------------------------------------------------------- 3. field performance numbers
create table if not exists public.client_metrics (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  name text not null check (name in ('lcp', 'fcp', 'cls', 'inp', 'ttfb', 'first_post', 'reel_start', 'reel_stall_ms', 'live_first_frame', 'live_reconnect')),
  value real not null check (value >= 0 and value < 600000),
  route text not null check (route in ('home', 'discover', 'reels', 'live', 'profile', 'other')),
  net text not null check (net in ('4g', '3g', '2g', 'slow-2g', 'unknown')),
  mode text not null check (mode in ('auto', 'high', 'saver', 'device')),
  device text not null check (device in ('phone', 'tablet', 'desktop'))
);
create index if not exists client_metrics_name_time_idx on public.client_metrics (name, created_at desc);
alter table public.client_metrics enable row level security;
revoke all on public.client_metrics from anon, authenticated;

create table if not exists public.client_metric_quota (
  user_id uuid primary key references auth.users(id) on delete cascade,
  day date not null,
  n integer not null
);
alter table public.client_metric_quota enable row level security;
revoke all on public.client_metric_quota from anon, authenticated;

create or replace function public.record_client_metrics(samples jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare k integer; used integer;
begin
  if auth.uid() is null or jsonb_typeof(samples) is distinct from 'array' then return 0; end if;
  k := least(jsonb_array_length(samples), 30);
  if k = 0 then return 0; end if;
  insert into public.client_metric_quota as q (user_id, day, n) values (auth.uid(), current_date, k)
    on conflict (user_id) do update set n = case when q.day = current_date then q.n + k else k end, day = current_date
    returning n into used;
  if used > 300 then return 0; end if;
  insert into public.client_metrics (name, value, route, net, mode, device)
  select e->>'n', (e->'v')::numeric::real, e->>'r', e->>'c', e->>'m', e->>'d'
  from (select value as e from jsonb_array_elements(samples) limit 30) s
  where (case when jsonb_typeof(e->'v') = 'number' then (e->'v')::numeric end) >= 0           -- never casts a non-number
    and (case when jsonb_typeof(e->'v') = 'number' then (e->'v')::numeric end) < 600000
    and e->>'n' in ('lcp', 'fcp', 'cls', 'inp', 'ttfb', 'first_post', 'reel_start', 'reel_stall_ms', 'live_first_frame', 'live_reconnect')
    and e->>'r' in ('home', 'discover', 'reels', 'live', 'profile', 'other')
    and e->>'c' in ('4g', '3g', '2g', 'slow-2g', 'unknown')
    and e->>'m' in ('auto', 'high', 'saver', 'device')
    and e->>'d' in ('phone', 'tablet', 'desktop');
  get diagnostics k = row_count;
  if random() < 0.02 then delete from public.client_metrics where created_at < now() - interval '30 days'; end if;   -- retention
  return k;
end $$;

-- Percentiles for admins: one row per metric and route (and data mode), over the last `days` days.
create or replace function public.client_metrics_summary(days integer default 7)
returns table (name text, route text, mode text, n bigint, p50 real, p75 real, p95 real)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return query
    select m.name, m.route, m.mode, count(*),
           percentile_cont(0.5) within group (order by m.value)::real,
           percentile_cont(0.75) within group (order by m.value)::real,
           percentile_cont(0.95) within group (order by m.value)::real
    from public.client_metrics m
    where m.created_at > now() - make_interval(days => greatest(1, least(days, 30)))
    group by m.name, m.route, m.mode
    order by m.name, m.route, m.mode;
end $$;

revoke execute on function public.record_client_metrics(jsonb), public.client_metrics_summary(integer) from public, anon;
grant execute on function public.record_client_metrics(jsonb), public.client_metrics_summary(integer) to authenticated;
