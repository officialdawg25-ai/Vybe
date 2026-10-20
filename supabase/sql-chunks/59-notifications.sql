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
