-- Home billboard: admin-managed promo slides (commercial placements) + auto-selected trending events.
--   * Slides are plain rows managed by administrators only; members can read only slides that are live right now.
--   * Impressions/clicks are counted once per member per slide per day, as aggregate counters (no per-person ad history is exposed).
--   * "Trending" is a defined formula over real activity, computed in SQL and always limited to events the viewer may see.
-- Additive and re-runnable.

-- Settings row for the billboard lives next to the auth hero.
alter table public.site_settings drop constraint if exists site_settings_key_check;
alter table public.site_settings add constraint site_settings_key_check check (key in ('auth_hero', 'home_hero'));

create table if not exists public.promo_slides (
  id uuid primary key default gen_random_uuid(),
  advertiser text not null default '' check (char_length(advertiser) <= 80),
  title text not null check (char_length(title) between 2 and 90),
  subtitle text not null default '' check (char_length(subtitle) <= 160),
  cta_label text not null default 'Learn more' check (char_length(cta_label) between 1 and 24),
  cta_url text not null check (cta_url ~ '^(/app/[A-Za-z0-9/_?=&.%-]*|https://[^\s]+)$' and char_length(cta_url) <= 500),
  media_type text check (media_type in ('image','video')),
  media_path text check (media_path ~ '^promo/[0-9a-f-]{36}\.(jpg|png|webp|mp4|webm)$'),
  poster_path text check (poster_path ~ '^promo/[0-9a-f-]{36}\.(jpg|png|webp)$'),
  focal_x integer not null default 50 check (focal_x between 0 and 100),
  focal_y integer not null default 50 check (focal_y between 0 and 100),
  accent text not null default '#6a4cff' check (accent ~ '^#[0-9a-fA-F]{6}$'),
  sound text not null default 'chime' check (sound in ('none','chime')),   -- 'chime' = short stinger when the slide appears (video audio is separate: muted until the viewer opts in)
  city text check (city is null or char_length(city) <= 80),               -- null = everywhere; otherwise only members browsing that city
  priority integer not null default 50 check (priority between 0 and 100),
  status text not null default 'draft' check (status in ('draft','live','paused')),
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((media_type is null) = (media_path is null)),
  check (poster_path is null or media_type = 'video'),
  check (ends_at is null or ends_at > starts_at)
);
create index if not exists promo_slides_live_idx on public.promo_slides (status, starts_at, ends_at);

create table if not exists public.promo_seen (
  user_id uuid not null references public.profiles(id) on delete cascade,
  slide_id uuid not null references public.promo_slides(id) on delete cascade,
  day date not null default current_date,
  kind text not null check (kind in ('impression','click')),
  primary key (user_id, slide_id, day, kind)
);
create table if not exists public.promo_stats (
  slide_id uuid not null references public.promo_slides(id) on delete cascade,
  day date not null,
  impressions integer not null default 0,
  clicks integer not null default 0,
  primary key (slide_id, day)
);

alter table public.promo_slides enable row level security;
alter table public.promo_seen enable row level security;
alter table public.promo_stats enable row level security;
drop policy if exists promo_read on public.promo_slides;
create policy promo_read on public.promo_slides for select to authenticated
  using (public.is_admin() or (status = 'live' and starts_at <= now() and (ends_at is null or ends_at > now())));
drop policy if exists promo_write on public.promo_slides;
create policy promo_write on public.promo_slides for insert to authenticated with check (public.is_admin());
drop policy if exists promo_edit on public.promo_slides;
create policy promo_edit on public.promo_slides for update to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists promo_del on public.promo_slides;
create policy promo_del on public.promo_slides for delete to authenticated using (public.is_admin());
drop policy if exists promo_stats_read on public.promo_stats;
create policy promo_stats_read on public.promo_stats for select to authenticated using (public.is_admin());
revoke all on public.promo_slides, public.promo_seen, public.promo_stats from anon, authenticated;
grant select, delete on public.promo_slides to authenticated;
grant insert (advertiser, title, subtitle, cta_label, cta_url, media_type, media_path, poster_path, focal_x, focal_y, accent, sound, city, priority, status, starts_at, ends_at, created_by) on public.promo_slides to authenticated;
grant update (advertiser, title, subtitle, cta_label, cta_url, media_type, media_path, poster_path, focal_x, focal_y, accent, sound, city, priority, status, starts_at, ends_at, updated_at) on public.promo_slides to authenticated;
grant select on public.promo_stats to authenticated;

-- Promo media goes in the existing public `brand` bucket under promo/ (admins only), next to the sign-in hero.
drop policy if exists brand_admin_insert on storage.objects;
create policy brand_admin_insert on storage.objects for insert to authenticated
  with check (bucket_id in ('brand', 'brand-draft') and public.is_admin() and name ~ '^(hero|promo)/[0-9a-f-]{36}\.(jpg|png|webp|mp4|webm)$');

-- Counts one impression / one click per member per slide per day. Rate limited; returns whether it counted.
create or replace function public.promo_track(p_slide uuid, p_kind text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare counted integer;
begin
  if auth.uid() is null then raise exception 'Sign in' using errcode = '28000'; end if;
  if p_kind not in ('impression','click') then raise exception 'bad kind'; end if;
  if not exists (select 1 from public.promo_slides s where s.id = p_slide and s.status = 'live' and s.starts_at <= now() and (s.ends_at is null or s.ends_at > now())) then return false; end if;
  if (select count(*) from public.promo_seen where user_id = auth.uid() and day = current_date) >= 400 then return false; end if;
  insert into public.promo_seen (user_id, slide_id, kind) values (auth.uid(), p_slide, p_kind) on conflict do nothing;
  get diagnostics counted = row_count;
  if counted = 0 then return false; end if;
  insert into public.promo_stats (slide_id, day, impressions, clicks) values (p_slide, current_date, (p_kind = 'impression')::int, (p_kind = 'click')::int)
  on conflict (slide_id, day) do update set impressions = public.promo_stats.impressions + (p_kind = 'impression')::int, clicks = public.promo_stats.clicks + (p_kind = 'click')::int;
  return true;
end $$;

-- Billboard behaviour (admin editable). Members read the merged defaults through home_hero_settings().
create or replace function public.home_hero_settings() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('trending_enabled', true, 'max_trending', 5, 'autoplay_ms', 7000, 'sponsored_every', 3)
         || coalesce((select published from public.site_settings where key = 'home_hero'), '{}'::jsonb);
$$;
create or replace function public.save_home_hero_settings(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v jsonb;
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  v := jsonb_build_object(
    'trending_enabled', coalesce((p->>'trending_enabled')::boolean, true),
    'max_trending', least(10, greatest(0, coalesce((p->>'max_trending')::int, 5))),
    'autoplay_ms', least(20000, greatest(3000, coalesce((p->>'autoplay_ms')::int, 7000))),
    'sponsored_every', least(6, greatest(2, coalesce((p->>'sponsored_every')::int, 3))));
  insert into public.site_settings (key, published, published_by, published_at, updated_by, updated_at) values ('home_hero', v, auth.uid(), now(), auth.uid(), now())
  on conflict (key) do update set published = excluded.published, published_by = excluded.published_by, published_at = excluded.published_at, updated_by = excluded.updated_by, updated_at = excluded.updated_at;
  insert into public.audit_log (actor, action, entity_type, detail) values (auth.uid(), 'home_hero.settings', 'site_settings', v);
  return v;
end $$;

-- Trending events. Score = 3 × tickets sold in the last 7 days + 2 × new "going" in the last 7 days + 0.5 × total going
-- + 5 if it starts within 14 days. An event is "trending" only if it had any such activity in the last 7 days; the list is
-- padded with the soonest upcoming plans (trending = false) so the billboard is never empty. Only events the caller may
-- already see (public, not blocked) are returned, and the counts are aggregates.
create or replace function public.trending_events(p_lat double precision default null, p_lng double precision default null, p_radius_km double precision default 100, p_limit integer default 8) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare r jsonb;
begin
  if auth.uid() is null then raise exception 'Sign in' using errcode = '28000'; end if;
  with cand as (
    select e.id, e.title, e.starts_at, e.timezone, e.city, e.venue, e.cover_path, e.lat, e.lng, e.host,
      (select coalesce(sum(oi.qty), 0) from public.order_items oi join public.orders o on o.id = oi.order_id
        where o.event_id = e.id and o.status in ('paid','partially_refunded') and o.paid_at > now() - interval '7 days') as sold7,
      (select count(*) from public.event_rsvps x where x.event_id = e.id and x.status = 'going' and x.updated_at > now() - interval '7 days') as rsvp7,
      (select count(*) from public.event_rsvps x where x.event_id = e.id and x.status = 'going') as going,
      (select min(t.price_cents) from public.ticket_types t where t.event_id = e.id and t.status = 'active') as price_from
    from public.events e
    where e.status = 'active' and e.visibility = 'public' and e.host <> auth.uid()
      and coalesce(e.ends_at, e.starts_at + interval '4 hours') >= now() and e.starts_at <= now() + interval '120 days'
      and public.can_view_event(e)
      and (p_lat is null or (e.lat is not null and e.lng is not null and 6371 * 2 * asin(least(1, sqrt(power(sin(radians(e.lat - p_lat) / 2), 2)
            + cos(radians(p_lat)) * cos(radians(e.lat)) * power(sin(radians(e.lng - p_lng) / 2), 2)))) <= least(p_radius_km, 500)))
  ), scored as (
    select c.*, (sold7 + rsvp7) > 0 as hot,
           (3 * sold7 + 2 * rsvp7 + 0.5 * going + case when starts_at <= now() + interval '14 days' then 5 else 0 end)::numeric as score
    from cand c
  ), top as (select * from scored order by hot desc, score desc, starts_at limit least(greatest(p_limit, 1), 20))
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'title', title, 'starts_at', starts_at, 'timezone', timezone, 'city', city, 'venue', venue,
      'cover_path', cover_path, 'going', going, 'price_from_cents', price_from, 'trending', hot, 'score', score) order by hot desc, score desc, starts_at), '[]'::jsonb)
    into r from top;
  return r;
end $$;

revoke execute on function public.promo_track(uuid, text), public.home_hero_settings(), public.save_home_hero_settings(jsonb), public.trending_events(double precision, double precision, double precision, integer) from public, anon;
grant execute on function public.promo_track(uuid, text), public.home_hero_settings(), public.save_home_hero_settings(jsonb), public.trending_events(double precision, double precision, double precision, integer) to authenticated;
