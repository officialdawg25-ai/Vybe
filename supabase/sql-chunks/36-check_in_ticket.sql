-- Door check-in: atomic and single use. Only the event's host or organization editors may scan.
create or replace function public.check_in_ticket(p_code text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare t public.tickets; tt public.ticket_types; holder public.profiles; c text := upper(trim(p_code));
begin
  select * into t from public.tickets where code = c;
  if not found then return jsonb_build_object('result', 'invalid'); end if;
  if not public.can_manage_event(t.event_id) then return jsonb_build_object('result', 'forbidden'); end if;
  select * into tt from public.ticket_types where id = t.ticket_type_id;
  select * into holder from public.profiles where id = t.owner;
  update public.tickets set status = 'used', used_at = now(), used_by = auth.uid() where id = t.id and status = 'valid';
  if found then
    return jsonb_build_object('result', 'ok', 'ticket_type', tt.name, 'holder', coalesce(nullif(holder.display_name, ''), holder.username));
  end if;
  select * into t from public.tickets where id = t.id;
  return jsonb_build_object('result', case when t.status = 'void' then 'void' else 'used' end, 'ticket_type', tt.name,
                            'holder', coalesce(nullif(holder.display_name, ''), holder.username), 'used_at', t.used_at);
end $$;

revoke execute on function public.check_in_ticket(text) from public, anon;

grant execute on function public.check_in_ticket(text) to authenticated;

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
