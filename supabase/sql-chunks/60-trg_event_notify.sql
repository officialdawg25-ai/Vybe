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
