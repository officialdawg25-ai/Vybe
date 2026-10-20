-- ---------------------------------------------------------------- discovery: artists / venues / organisers
-- Ordered by "has something coming up", then newest — deliberately NOT by follower count, so new local acts are findable.
create or replace function public.discover_orgs(p_kinds text[] default null, p_q text default null, p_followed boolean default false, p_limit integer default 24, p_offset integer default 0) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare r jsonb; me uuid := auth.uid(); q text := nullif(btrim(replace(replace(coalesce(p_q, ''), '%', ''), '_', '')), '');
begin
  if me is null then raise exception 'Sign in' using errcode = '28000'; end if;
  select coalesce(jsonb_agg(x.j order by x.upcoming desc, x.created_at desc), '[]'::jsonb) into r from (
    select jsonb_build_object('id', o.id, 'name', o.name, 'slug', o.slug, 'kind', o.kind, 'description', o.description, 'avatar_path', o.avatar_path,
        'verified', o.verified_at is not null,
        'followers', (select count(*) from public.follows f where f.target_type = 'organization' and f.target_id = o.id),
        'upcoming', up.n, 'following', fl.f) as j, up.n as upcoming, o.created_at
    from public.organizations o
    cross join lateral (select count(*) as n from public.events e where e.organization_id = o.id and e.status = 'active' and e.visibility = 'public' and e.starts_at >= now() and public.can_view_event(e)) up
    cross join lateral (select exists (select 1 from public.follows f where f.follower = me and f.target_type = 'organization' and f.target_id = o.id) as f) fl
    where (p_kinds is null or o.kind = any (p_kinds))
      and (q is null or o.name ilike '%' || q || '%' or o.description ilike '%' || q || '%')
      and (not p_followed or fl.f)
    order by up.n desc, o.created_at desc
    limit least(greatest(p_limit, 1), 50) offset greatest(p_offset, 0)
  ) x;
  return r;
end $$;

-- ---------------------------------------------------------------- discovery: event-related live broadcasts
-- Only streams attached to an event the viewer may see. Individual live streams (no event) are never listed here — they stay on Home.
-- A scheduled stream is returned with status 'scheduled' and is never labelled live.
create or replace function public.discover_live(p_limit integer default 20) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare r jsonb; me uuid := auth.uid();
begin
  if me is null then raise exception 'Sign in' using errcode = '28000'; end if;
  select coalesce(jsonb_agg(x.j order by x.live desc, x.at), '[]'::jsonb) into r from (
    select jsonb_build_object('id', s.id, 'title', s.title, 'status', s.status, 'access', s.access, 'scheduled_for', s.scheduled_for, 'started_at', s.started_at,
        'viewers', case when s.status = 'live' then s.viewers_peak end,
        'can_watch', public.can_watch_stream(s.id),
        'host', (select coalesce(nullif(p.display_name, ''), p.username) from public.profiles p where p.id = s.host),
        'org', (select o.name from public.organizations o where o.id = s.organization_id),
        'event', jsonb_build_object('id', e.id, 'title', e.title, 'city', e.city, 'venue', e.venue, 'cover_path', e.cover_path, 'starts_at', e.starts_at, 'timezone', e.timezone, 'format', e.format)) as j,
      (s.status = 'live') as live, coalesce(s.started_at, s.scheduled_for, s.created_at) as at
    from public.live_streams s join public.events e on e.id = s.event_id
    where s.status in ('live', 'scheduled') and s.event_id is not null
      and (s.status = 'live' or coalesce(s.scheduled_for, e.starts_at) between now() - interval '2 hours' and now() + interval '7 days')
      and e.status = 'active' and s.visibility = 'public' and public.can_view_event(e) and not public.is_blocked(me, s.host)
      and not exists (select 1 from public.live_bans b where b.stream_id = s.id and b.user_id = me)
    order by (s.status = 'live') desc, coalesce(s.started_at, s.scheduled_for, s.created_at)
    limit least(greatest(p_limit, 1), 40)
  ) x;
  return r;
end $$;

-- ---------------------------------------------------------------- maps: per-member rate limit (the edge function calls this AS THE USER)
create table if not exists public.maps_usage_log (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  op text not null,
  created_at timestamptz not null default now()
);

create index if not exists maps_usage_user_idx on public.maps_usage_log (user_id, created_at desc);
