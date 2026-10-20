-- LiveKit live streaming: access rules, bans, token gate, and webhook-driven state. Additive and re-runnable.
--   * The browser never talks to LiveKit without a token minted by the `livekit-token` edge function.
--   * That function calls live_token_gate() AS THE USER, so every rule below is evaluated with the caller's identity.
--   * Stream state (live / ended, peak viewers) is written only by the LiveKit webhook function (service role).

alter table public.live_streams add column if not exists access text not null default 'open' check (access in ('open','ticket'));
alter table public.live_streams add column if not exists viewers_peak integer not null default 0;
alter table public.live_streams add column if not exists ended_reason text;
grant insert (access) on public.live_streams to authenticated;
grant update (access) on public.live_streams to authenticated;
-- 'ticket' streams must belong to an event so there is something to check a ticket against.
alter table public.live_streams drop constraint if exists live_ticket_needs_event;
alter table public.live_streams add constraint live_ticket_needs_event check (access = 'open' or event_id is not null);

-- Only the host of an event (or its organization editors) may attach a stream to it.
drop policy if exists live_insert on public.live_streams;
create policy live_insert on public.live_streams for insert to authenticated
  with check (host = auth.uid() and status = 'scheduled'
    and (organization_id is null or public.org_role(organization_id) in ('owner','admin','editor'))
    and (event_id is null or public.can_manage_event(event_id)));

create table if not exists public.live_bans (
  stream_id uuid not null references public.live_streams(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (stream_id, user_id)
);
alter table public.live_bans enable row level security;
drop policy if exists live_bans_host on public.live_bans;
create policy live_bans_host on public.live_bans for select to authenticated
  using (exists (select 1 from public.live_streams s where s.id = stream_id and s.host = auth.uid()));
revoke all on public.live_bans from anon, authenticated;
grant select on public.live_bans to authenticated;

-- Short-lived log used to rate-limit token minting (nobody can read it from the API).
create table if not exists public.live_access_log (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  stream_id uuid not null,
  role text not null,
  created_at timestamptz not null default now()
);
create index if not exists live_access_log_user_idx on public.live_access_log (user_id, created_at desc);
alter table public.live_access_log enable row level security;
revoke all on public.live_access_log from anon, authenticated;

-- Can the caller watch this stream? (visibility, blocks, bans, ticket gate)
create or replace function public.can_watch_stream(sid uuid) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare s public.live_streams;
begin
  select * into s from public.live_streams where id = sid;
  if not found or s.status in ('ended','cancelled') then return false; end if;
  if s.host = auth.uid() then return true; end if;
  if public.is_blocked(auth.uid(), s.host) then return false; end if;
  if exists (select 1 from public.live_bans b where b.stream_id = sid and b.user_id = auth.uid()) then return false; end if;
  if not (s.visibility = 'public' or (s.visibility = 'friends' and public.are_friends(auth.uid(), s.host))) then return false; end if;
  if s.access = 'ticket' then
    return public.can_manage_event(s.event_id)
        or exists (select 1 from public.tickets t where t.event_id = s.event_id and t.owner = auth.uid() and t.status in ('valid','used'));
  end if;
  return true;
end $$;

-- Called by the livekit-token edge function with the USER's JWT. Returns what the function needs to mint a token, or raises.
create or replace function public.live_token_gate(sid uuid, want_publish boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.live_streams; p public.profiles; recent integer; is_host boolean;
begin
  if auth.uid() is null then raise exception 'Sign in to watch' using errcode = '28000'; end if;
  select * into s from public.live_streams where id = sid;
  if not found then raise exception 'Stream not found'; end if;
  select * into p from public.profiles where id = auth.uid();
  is_host := s.host = auth.uid();
  if want_publish and not is_host then raise exception 'Only the host can broadcast'; end if;
  if want_publish and s.status not in ('scheduled','live') then raise exception 'This stream has ended'; end if;
  if not want_publish and not public.can_watch_stream(sid) then
    raise exception '%', case when s.access = 'ticket' and s.status in ('scheduled','live') then 'You need a ticket for this event to watch' else 'This stream is not available' end;
  end if;
  select count(*) into recent from public.live_access_log where user_id = auth.uid() and created_at > now() - interval '1 minute';
  if recent >= 20 then raise exception 'Too many attempts. Please wait a moment.'; end if;
  insert into public.live_access_log (user_id, stream_id, role) values (auth.uid(), sid, case when want_publish then 'host' else 'viewer' end);
  delete from public.live_access_log where created_at < now() - interval '2 days' and id % 50 = 0;     -- cheap housekeeping
  return jsonb_build_object('room', s.room, 'title', s.title, 'status', s.status, 'role', case when want_publish then 'host' else 'viewer' end,
                            'name', coalesce(nullif(p.display_name, ''), p.username), 'host', s.host, 'recording_consent', s.recording_consent);
end $$;

-- Host-only moderation. The edge function also removes the person from the LiveKit room.
create or replace function public.ban_from_stream(sid uuid, target uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.live_streams where id = sid and host = auth.uid()) then raise exception 'forbidden' using errcode = '42501'; end if;
  if target = auth.uid() then raise exception 'You cannot remove yourself'; end if;
  insert into public.live_bans (stream_id, user_id) values (sid, target) on conflict do nothing;
end $$;

-- Host ends their own stream (the edge function then closes the LiveKit room). Webhook also ends it if the room empties.
create or replace function public.end_my_stream(sid uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.live_streams set status = 'ended', ended_at = now(), ended_reason = 'host'
   where id = sid and host = auth.uid() and status in ('scheduled','live');
  if not found then raise exception 'Nothing to end'; end if;
end $$;

-- Written by the LiveKit webhook only.
create or replace function public.live_apply_event(p_room text, p_event text, p_viewers integer default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_event = 'room_started' then
    update public.live_streams set status = 'live', started_at = coalesce(started_at, now()) where room = p_room and status = 'scheduled';
  elsif p_event = 'room_finished' then
    update public.live_streams set status = 'ended', ended_at = coalesce(ended_at, now()), ended_reason = coalesce(ended_reason, 'room_finished') where room = p_room and status in ('scheduled','live');
  elsif p_event = 'viewers' and p_viewers is not null then
    update public.live_streams set viewers_peak = greatest(viewers_peak, p_viewers) where room = p_room;
  end if;
end $$;

revoke execute on function public.can_watch_stream(uuid), public.live_token_gate(uuid, boolean), public.ban_from_stream(uuid, uuid), public.end_my_stream(uuid),
  public.live_apply_event(text, text, integer) from public, anon;
grant execute on function public.can_watch_stream(uuid), public.live_token_gate(uuid, boolean), public.ban_from_stream(uuid, uuid), public.end_my_stream(uuid) to authenticated;
revoke execute on function public.live_apply_event(text, text, integer) from authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.live_apply_event(text, text, integer) to service_role;
  end if;
end $$;
