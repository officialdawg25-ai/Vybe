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
