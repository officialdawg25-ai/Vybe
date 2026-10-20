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
create policy event_categories_admin on public.event_categories for all to authenticated using (public.is_admin()) with check (public.is_admin());
revoke all on public.event_categories from anon, authenticated;
grant select, insert, update, delete on public.event_categories to authenticated;
insert into public.event_categories (slug, label, group_key, sort) values
  ('concerts', 'Concerts & gigs', 'concerts', 10), ('festivals', 'Festivals', 'concerts', 20), ('comedy', 'Comedy', 'concerts', 30),
  ('theatre', 'Theatre & performance', 'concerts', 40), ('open-mic', 'Open mic & showcases', 'concerts', 50),
  ('nightlife', 'Nightlife & social', 'events', 60), ('arts-culture', 'Arts & culture', 'events', 70), ('sports', 'Sports & recreation', 'events', 80),
  ('workshops', 'Workshops & learning', 'events', 90), ('networking', 'Business & networking', 'events', 100), ('food', 'Food & lifestyle', 'events', 110),
  ('family', 'Family friendly', 'events', 120), ('student', 'University & student', 'events', 130), ('community', 'Local community', 'events', 140),
  ('other', 'Other', 'events', 999)
on conflict (slug) do nothing;

-- ---------------------------------------------------------------- events: category, format, drafts, provenance
alter table public.events add column if not exists category text references public.event_categories(slug) on update cascade on delete set null;
alter table public.events add column if not exists format text not null default 'in_person' check (format in ('in_person', 'online', 'hybrid'));
alter table public.events add column if not exists online_url text check (online_url is null or (char_length(online_url) <= 500 and online_url ~* '^https://'));
alter table public.events add column if not exists source text not null default 'vybe' check (source in ('vybe', 'external'));
alter table public.events add column if not exists source_name text check (source_name is null or char_length(source_name) <= 60);
alter table public.events add column if not exists source_url text check (source_url is null or (char_length(source_url) <= 500 and source_url ~* '^https://'));
alter table public.events drop constraint if exists events_status_check;
alter table public.events add constraint events_status_check check (status in ('draft', 'active', 'cancelled', 'completed'));
alter table public.events drop constraint if exists events_online_needs_link;
alter table public.events add constraint events_online_needs_link check (format = 'in_person' or online_url is not null or status = 'draft');
-- External listings can only be written by trusted server code (service role); browsers cannot claim a provider identity.
alter table public.events drop constraint if exists events_external_has_source;
alter table public.events add constraint events_external_has_source check (source = 'vybe' or (source_name is not null and source_url is not null));
create index if not exists events_discover_idx on public.events (status, visibility, starts_at);
create index if not exists events_category_idx on public.events (category) where category is not null;
grant insert (category, format, online_url, status) on public.events to authenticated;
grant update (category, format, online_url, status) on public.events to authenticated;
-- Table-level grants cover these columns, so a trigger (not a column revoke) keeps provider identity server-side only.
create or replace function public.trg_event_source_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if auth.uid() is not null and (new.source <> 'vybe' or new.source_name is not null or new.source_url is not null)
     and (tg_op = 'INSERT' or (new.source, new.source_name, new.source_url) is distinct from (old.source, old.source_name, old.source_url)) then
    raise exception 'External listings can only be created by VYBE servers' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists event_source_guard on public.events;
create trigger event_source_guard before insert or update on public.events for each row execute function public.trg_event_source_guard();

-- Drafts are visible to the host and the organization's editors only.
create or replace function public.can_view_event(e public.events) returns boolean
language sql stable security definer set search_path = '' as $$
  select e.host = auth.uid()
    or (e.organization_id is not null and public.org_role(e.organization_id) in ('owner', 'admin', 'editor'))
    or (e.status <> 'draft' and not public.is_blocked(auth.uid(), e.host) and (
      public.is_invited(e.id)
      or (e.visibility = 'public' and (e.community_id is null or public.community_is_public(e.community_id) or public.is_community_member(e.community_id)))
      or (e.visibility = 'friends' and public.are_friends(auth.uid(), e.host))
    ));
$$;

-- Artists are organizations too.
alter table public.organizations drop constraint if exists organizations_kind_check;
alter table public.organizations add constraint organizations_kind_check check (kind in ('organizer', 'venue', 'business', 'creator', 'brand', 'artist'));

-- ---------------------------------------------------------------- RSVP privacy
alter table public.event_rsvps add column if not exists visibility text not null default 'friends' check (visibility in ('public', 'friends', 'private'));
grant update (visibility) on public.event_rsvps to authenticated;
drop policy if exists rsvps_select on public.event_rsvps;
create policy rsvps_select on public.event_rsvps for select to authenticated
  using (user_id = auth.uid() or public.can_manage_event(event_id)
    or (public.can_view_event_id(event_id) and not public.is_blocked(auth.uid(), user_id)
        and (visibility = 'public' or (visibility = 'friends' and public.are_friends(auth.uid(), user_id)))));

-- ---------------------------------------------------------------- saved events (a bookmark is not attendance)
create table if not exists public.event_saves (
  user_id uuid not null references public.profiles(id) on delete cascade,
  event_id uuid not null references public.events(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, event_id)
);
alter table public.event_saves enable row level security;
drop policy if exists event_saves_own on public.event_saves;
create policy event_saves_own on public.event_saves for select to authenticated using (user_id = auth.uid());
drop policy if exists event_saves_ins on public.event_saves;
create policy event_saves_ins on public.event_saves for insert to authenticated with check (user_id = auth.uid() and public.can_view_event_id(event_id));
drop policy if exists event_saves_del on public.event_saves;
create policy event_saves_del on public.event_saves for delete to authenticated using (user_id = auth.uid());
revoke all on public.event_saves from anon, authenticated;
grant select, insert, delete on public.event_saves to authenticated;

-- ---------------------------------------------------------------- follows
create table if not exists public.follows (
  follower uuid not null references public.profiles(id) on delete cascade,
  target_type text not null check (target_type in ('profile', 'organization')),
  target_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (follower, target_type, target_id),
  check (target_type <> 'profile' or target_id <> follower)
);
create index if not exists follows_target_idx on public.follows (target_type, target_id);
alter table public.follows enable row level security;
drop policy if exists follows_own_read on public.follows;
create policy follows_own_read on public.follows for select to authenticated using (follower = auth.uid());
drop policy if exists follows_own_ins on public.follows;
create policy follows_own_ins on public.follows for insert to authenticated with check (follower = auth.uid());
drop policy if exists follows_own_del on public.follows;
create policy follows_own_del on public.follows for delete to authenticated using (follower = auth.uid());
revoke all on public.follows from anon, authenticated;
grant select, insert, delete on public.follows to authenticated;

-- The target must exist; nobody can follow someone who blocked them (or whom they blocked); capped to stop follow-spam.
create or replace function public.trg_follow_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  if new.target_type = 'profile' then
    if not exists (select 1 from public.profiles where id = new.target_id) then raise exception 'Not found'; end if;
    if public.is_blocked(new.follower, new.target_id) then raise exception 'You cannot follow this account'; end if;
  elsif not exists (select 1 from public.organizations where id = new.target_id) then
    raise exception 'Not found';
  end if;
  select count(*) into n from public.follows where follower = new.follower and created_at > now() - interval '1 hour';
  if n >= 100 then raise exception 'Too many follows in a short time. Try again later.'; end if;
  return new;
end $$;
drop trigger if exists follow_guard on public.follows;
create trigger follow_guard before insert on public.follows for each row execute function public.trg_follow_guard();

-- Aggregate only: how many follow this, and do I.
create or replace function public.follow_stats(p_type text, p_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('followers', (select count(*) from public.follows where target_type = p_type and target_id = p_id),
                            'following', exists (select 1 from public.follows where follower = auth.uid() and target_type = p_type and target_id = p_id));
$$;

-- ---------------------------------------------------------------- notifications
alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check check (type in
  ('friend_request', 'friend_accepted', 'reaction', 'comment', 'event_invite', 'rsvp', 'community_join', 'new_event', 'event_update', 'event_cancelled', 'live_started'));

-- Fan-out helper: inserts one notification per eligible recipient in ONE statement. Idempotent through (user_id, dedupe_key).
-- pref = the notif_prefs key a member can switch off. Capped so one publish can never write an unbounded number of rows inline;
-- a queue worker is the next step for very large audiences (see README).
create or replace function public.notify_many(recipients uuid[], t text, pref text, actor uuid, etype text, eid uuid, dkey text) returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  insert into public.notifications (user_id, type, actor_id, entity_type, entity_id, dedupe_key)
  select distinct p.id, t, actor, etype, eid, dkey
  from public.profiles p
  where p.id = any (recipients) and p.id is distinct from actor
    and coalesce((p.notif_prefs ->> pref)::boolean, true)
    and (actor is null or not public.is_blocked(p.id, actor))
  limit 5000
  on conflict (user_id, dedupe_key) do nothing;
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function public.notify_many(uuid[], text, text, uuid, text, uuid, text) from public, anon, authenticated;

create or replace function public.event_followers(e public.events) returns uuid[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(distinct u), '{}') from (
    select f.follower as u from public.follows f
      where (f.target_type = 'profile' and f.target_id = e.host) or (f.target_type = 'organization' and e.organization_id is not null and f.target_id = e.organization_id)
    union
    select cm.user_id from public.community_members cm where e.community_id is not null and cm.community_id = e.community_id and cm.status = 'active'
  ) x;
$$;
revoke execute on function public.event_followers(public.events) from public, anon, authenticated;

create or replace function public.event_attendees(eid uuid) returns uuid[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(distinct u), '{}') from (
    select user_id as u from public.event_rsvps where event_id = eid and status in ('going', 'maybe')
    union select owner from public.tickets where event_id = eid and status in ('valid', 'used')
  ) x;
$$;
revoke execute on function public.event_attendees(uuid) from public, anon, authenticated;

-- Publication events (not edits of drafts): new, material change, cancellation. Each notification has a stable dedupe key, so
-- retries, repeated saves and webhook replays never double-notify.
create or replace function public.trg_event_notify() returns trigger
language plpgsql security definer set search_path = '' as $$
declare published boolean; sig text;
begin
  published := new.status = 'active' and (tg_op = 'INSERT' or old.status = 'draft');
  if published and new.visibility = 'public' then
    perform public.notify_many(public.event_followers(new), 'new_event', 'new_event', new.host, 'event', new.id, 'ev:new:' || new.id);
  elsif tg_op = 'UPDATE' and new.status = 'cancelled' and old.status = 'active' then
    perform public.notify_many(public.event_attendees(new.id), 'event_cancelled', 'event_update', new.host, 'event', new.id, 'ev:cancel:' || new.id);
  elsif tg_op = 'UPDATE' and new.status = 'active' and old.status = 'active' and
        (new.starts_at, new.ends_at, new.venue, new.address, new.location, new.lat, new.lng, new.online_url, new.format)
        is distinct from (old.starts_at, old.ends_at, old.venue, old.address, old.location, old.lat, old.lng, old.online_url, old.format) then
    sig := md5(concat_ws('|', new.starts_at, new.ends_at, new.venue, new.address, new.location, new.lat, new.lng, new.online_url, new.format));
    perform public.notify_many(public.event_attendees(new.id), 'event_update', 'event_update', new.host, 'event', new.id, 'ev:upd:' || new.id || ':' || sig);
  end if;
  return new;
end $$;
drop trigger if exists event_notify on public.events;
create trigger event_notify after insert or update on public.events for each row execute function public.trg_event_notify();

-- Event-related broadcast going live: tell people who are going/interested/ticketed and followers (ticket-gated streams: ticket holders only).
create or replace function public.notify_live_started(sid uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare s public.live_streams; e public.events; who uuid[];
begin
  select * into s from public.live_streams where id = sid;
  if not found or s.event_id is null or s.visibility <> 'public' then return; end if;
  select * into e from public.events where id = s.event_id;
  if not found or e.status <> 'active' then return; end if;
  if s.access = 'ticket' then
    select coalesce(array_agg(distinct owner), '{}') into who from public.tickets where event_id = e.id and status in ('valid', 'used');
  else
    who := public.event_attendees(e.id) || public.event_followers(e);
  end if;
  perform public.notify_many(who, 'live_started', 'live_started', s.host, 'live', s.id, 'live:' || s.id);
end $$;
revoke execute on function public.notify_live_started(uuid) from public, anon, authenticated;

create or replace function public.live_apply_event(p_room text, p_event text, p_viewers integer default null) returns void
language plpgsql security definer set search_path = '' as $$
declare sid uuid;
begin
  if p_event = 'room_started' then
    update public.live_streams set status = 'live', started_at = coalesce(started_at, now()) where room = p_room and status = 'scheduled' returning id into sid;
    if sid is not null then perform public.notify_live_started(sid); end if;
  elsif p_event = 'room_finished' then
    update public.live_streams set status = 'ended', ended_at = coalesce(ended_at, now()), ended_reason = coalesce(ended_reason, 'room_finished') where room = p_room and status in ('scheduled', 'live');
  elsif p_event = 'viewers' and p_viewers is not null then
    update public.live_streams set viewers_peak = greatest(viewers_peak, p_viewers) where room = p_room;
  end if;
end $$;
revoke execute on function public.live_apply_event(text, text, integer) from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then grant execute on function public.live_apply_event(text, text, integer) to service_role; end if;
end $$;

-- ---------------------------------------------------------------- social context for one event
create or replace function public.event_social(p_event uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare r jsonb;
begin
  if auth.uid() is null or not public.can_view_event_id(p_event) then return null; end if;
  select jsonb_build_object(
    'going', (select count(*) from public.event_rsvps where event_id = p_event and status = 'going'),
    'interested', (select count(*) from public.event_rsvps where event_id = p_event and status = 'maybe'),
    'saved', exists (select 1 from public.event_saves where event_id = p_event and user_id = auth.uid()),
    'mine', (select jsonb_build_object('status', status, 'visibility', visibility) from public.event_rsvps where event_id = p_event and user_id = auth.uid()),
    'people', coalesce((
      select jsonb_agg(jsonb_build_object('id', x.id, 'username', x.username, 'display_name', x.display_name, 'avatar_path', x.avatar_path, 'status', x.status, 'friend', x.friend) order by x.friend desc, x.updated_at desc)
      from (select p.id, p.username, p.display_name, p.avatar_path, r.status, r.updated_at, public.are_friends(auth.uid(), p.id) as friend
            from public.event_rsvps r join public.profiles p on p.id = r.user_id
            where r.event_id = p_event and r.status in ('going', 'maybe') and r.user_id <> auth.uid()
              and not public.is_blocked(auth.uid(), r.user_id)
              and (r.visibility = 'public' or (r.visibility = 'friends' and public.are_friends(auth.uid(), r.user_id)))
            order by public.are_friends(auth.uid(), p.id) desc, r.updated_at desc limit 24) x), '[]'::jsonb)
  ) into r;
  return r;
end $$;

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
alter table public.maps_usage_log enable row level security;
revoke all on public.maps_usage_log from anon, authenticated;
create or replace function public.maps_gate(p_op text) returns void
language plpgsql security definer set search_path = '' as $$
declare recent integer;
begin
  if auth.uid() is null then raise exception 'Sign in' using errcode = '28000'; end if;
  select count(*) into recent from public.maps_usage_log where user_id = auth.uid() and created_at > now() - interval '1 minute';
  if recent >= 40 then raise exception 'Too many map requests. Please wait a moment.'; end if;
  insert into public.maps_usage_log (user_id, op) values (auth.uid(), left(p_op, 20));
  delete from public.maps_usage_log where created_at < now() - interval '2 days' and id % 50 = 0;
end $$;

revoke execute on function public.follow_stats(text, uuid), public.event_social(uuid), public.discover_events(text, text, text[], text, boolean, timestamptz, timestamptz, double precision, double precision, double precision, boolean, boolean, boolean, text, integer, integer),
  public.discover_orgs(text[], text, boolean, integer, integer), public.discover_live(integer), public.maps_gate(text) from public, anon;
grant execute on function public.follow_stats(text, uuid), public.event_social(uuid), public.discover_events(text, text, text[], text, boolean, timestamptz, timestamptz, double precision, double precision, double precision, boolean, boolean, boolean, text, integer, integer),
  public.discover_orgs(text[], text, boolean, integer, integer), public.discover_live(integer), public.maps_gate(text) to authenticated;
