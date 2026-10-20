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
