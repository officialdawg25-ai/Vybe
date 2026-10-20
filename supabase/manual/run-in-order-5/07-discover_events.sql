-- ---------------------------------------------------------------- discovery: events
-- SECURITY DEFINER so counts are true aggregates, but every row is gated by can_view_event() (blocks, community privacy, drafts).
-- Only public, active, not-yet-finished events are discoverable. Order is by start time or distance — never by engagement.
create or replace function public.discover_events(
  p_q text default null, p_group text default null, p_categories text[] default null, p_format text default null, p_free boolean default null,
  p_from timestamptz default now(), p_to timestamptz default null, p_lat double precision default null, p_lng double precision default null,
  p_radius_km double precision default null, p_followed boolean default false, p_friends boolean default false, p_saved boolean default false,
  p_sort text default 'soonest', p_limit integer default 20, p_offset integer default 0) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare r jsonb; me uuid := auth.uid(); q text := nullif(btrim(replace(replace(coalesce(p_q, ''), '%', ''), '_', '')), ''); rad double precision := least(coalesce(p_radius_km, 100), 500);
begin
  if me is null then raise exception 'Sign in' using errcode = '28000'; end if;
  with base as (
    select e.*,
      case when p_lat is not null and e.lat is not null and e.lng is not null then
        6371 * 2 * asin(least(1, sqrt(power(sin(radians(e.lat - p_lat) / 2), 2) + cos(radians(p_lat)) * cos(radians(e.lat)) * power(sin(radians(e.lng - p_lng) / 2), 2)))) end as km
    from public.events e
    where e.status = 'active' and e.visibility = 'public'
      and coalesce(e.ends_at, e.starts_at + interval '4 hours') >= p_from and (p_to is null or e.starts_at <= p_to)
      and (p_group is null or e.category in (select slug from public.event_categories where group_key = p_group and active))
      and (p_categories is null or e.category = any (p_categories))
      and (p_format is null or (p_format = 'online' and e.format in ('online', 'hybrid')) or (p_format = 'in_person' and e.format in ('in_person', 'hybrid')))
      and (p_free is null or (p_free and coalesce(e.price_cents, 0) = 0 and not exists (select 1 from public.ticket_types t where t.event_id = e.id and t.status = 'active' and t.price_cents > 0))
                          or (not p_free and (coalesce(e.price_cents, 0) > 0 or exists (select 1 from public.ticket_types t where t.event_id = e.id and t.status = 'active' and t.price_cents > 0))))
      and public.can_view_event(e)
  ), located as (
    select * from base where p_lat is null or (km is not null and km <= rad) or (km is null and format = 'online')
  ), filtered as (
    select l.*,
      exists (select 1 from public.follows f where f.follower = me and ((f.target_type = 'profile' and f.target_id = l.host) or (f.target_type = 'organization' and f.target_id = l.organization_id))) as followed
    from located l
    where (q is null or l.title ilike '%' || q || '%' or l.venue ilike '%' || q || '%' or l.city ilike '%' || q || '%' or l.location ilike '%' || q || '%'
           or exists (select 1 from public.event_lineup a where a.event_id = l.id and a.name ilike '%' || q || '%')
           or exists (select 1 from public.profiles h where h.id = l.host and (h.display_name ilike '%' || q || '%' or h.username ilike '%' || q || '%'))
           or exists (select 1 from public.organizations o where o.id = l.organization_id and o.name ilike '%' || q || '%'))
      and (not p_saved or exists (select 1 from public.event_saves s where s.user_id = me and s.event_id = l.id))
  ), shaped as (
    select f.*, fr.n as friends_going, fr.avatars as friend_avatars from filtered f
    left join lateral (
      select count(*) as n, (array_agg(jsonb_build_object('username', p.username, 'display_name', p.display_name, 'avatar_path', p.avatar_path)))[1:3] as avatars
      from public.event_rsvps r join public.profiles p on p.id = r.user_id
      where r.event_id = f.id and r.status = 'going' and r.user_id <> me and (r.visibility in ('public', 'friends')) and public.are_friends(me, r.user_id)
    ) fr on true
    where (not p_followed or f.followed) and (not p_friends or coalesce(fr.n, 0) > 0)
  ), page as (
    select * from shaped order by case when p_sort = 'nearest' then coalesce(km, 1e9) end, starts_at, id
    limit least(greatest(p_limit, 1), 40) offset greatest(p_offset, 0)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', pg.id, 'title', pg.title, 'starts_at', pg.starts_at, 'ends_at', pg.ends_at, 'timezone', pg.timezone, 'city', pg.city, 'venue', pg.venue, 'location', pg.location,
    'cover_path', pg.cover_path, 'category', pg.category, 'category_label', (select c.label from public.event_categories c where c.slug = pg.category),
    'format', pg.format, 'lat', pg.lat, 'lng', pg.lng, 'distance_km', round(pg.km::numeric, 1), 'source', pg.source, 'source_name', pg.source_name,
    'price_from_cents', (select min(t.price_cents) from public.ticket_types t where t.event_id = pg.id and t.status = 'active'), 'price_cents', pg.price_cents, 'currency', pg.currency, 'has_tickets', exists (select 1 from public.ticket_types t where t.event_id = pg.id and t.status = 'active'),
    'going', (select count(*) from public.event_rsvps x where x.event_id = pg.id and x.status = 'going'),
    'friends_going', coalesce(pg.friends_going, 0), 'friend_avatars', coalesce(pg.friend_avatars, '{}'),
    'followed', pg.followed,
    'live', exists (select 1 from public.live_streams ls where ls.event_id = pg.id and ls.status = 'live' and ls.visibility = 'public'),
    'artists', (select coalesce(jsonb_agg(a.name order by a.sort), '[]') from (select name, sort from public.event_lineup where event_id = pg.id order by sort limit 3) a),
    'host', (select jsonb_build_object('id', h.id, 'username', h.username, 'display_name', h.display_name, 'avatar_path', h.avatar_path) from public.profiles h where h.id = pg.host),
    'org', (select jsonb_build_object('id', o.id, 'name', o.name, 'slug', o.slug, 'verified', o.verified_at is not null) from public.organizations o where o.id = pg.organization_id)
  ) order by case when p_sort = 'nearest' then coalesce(pg.km, 1e9) end, pg.starts_at, pg.id), '[]'::jsonb) into r from page pg;
  return r;
end $$;
