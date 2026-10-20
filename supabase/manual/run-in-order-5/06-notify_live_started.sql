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
