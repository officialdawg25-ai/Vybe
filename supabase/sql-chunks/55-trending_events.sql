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

-- Discover upgrade: configurable categories, event format/draft state, follows (people + organizations), per-RSVP privacy,
-- saved events, follower/attendee-aware discovery RPCs, event-related live listing, preference-aware notifications and a maps rate limit.
-- Additive and re-runnable. Existing events, RSVPs and notifications are preserved.
--   * Artists / venues / organisers are `organizations` (kind now includes 'artist'); people can be followed too.
--   * Communities are "followed" by joining (community_members) — no second relationship table.
--   * "Interested" is the existing RSVP status 'maybe'; "Going" is 'going'. Saved is separate (event_saves).

-- ---------------------------------------------------------------- categories (admin-configurable source of truth)
create table if not exists public.event_categories (
  slug text primary key check (slug ~ '^[a-z0-9-]{2,30}$'),
  label text not null check (char_length(label) between 2 and 40),
  group_key text not null default 'events' check (group_key in ('concerts', 'events')),   -- 'concerts' = shown under Concerts & shows
  sort integer not null default 100,
  active boolean not null default true
);

alter table public.event_categories enable row level security;

drop policy if exists event_categories_read on public.event_categories;

create policy event_categories_read on public.event_categories for select to authenticated using (true);

drop policy if exists event_categories_admin on public.event_categories;
