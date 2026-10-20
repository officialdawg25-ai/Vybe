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
