-- 43: Event admission — entry windows, sessions, zones and gates, reserved seats, re-entry, gate-scoped door teams,
-- scanner sessions, idempotent scans, explicit decision codes, ticket references, credential rotation on transfer/reissue.
--
-- What already existed (migrations 6, 8, 28, 37) and is kept: row-locked inventory and holds, verified PayFast/Ozow
-- settlement that issues tickets exactly once, event-bound atomic redemption (admit_ticket), door staff per event, a log of
-- every scan, throttling of bad codes, holder-only static codes and signed 30-second rotating QR tokens.
--
-- What this adds:
--  1. Events: 'postponed' status, explicit doors-open and entry-close times, an append-only schedule history.
--  2. Sessions (multi-day / afternoon + evening) and which ticket types admit to which session.
--  3. Zones (general, VIP, VVIP, backstage, accessible, ...) and gates; a ticket type grants zones; a gate serves zones and
--     may refuse tickets that grant no zone (e.g. a VVIP-only entrance).
--  4. Reserved seats: event_seats (unique per event/section/row/seat), a ticket holds at most one seat and a seat belongs to
--     at most one live ticket (unique index). Reserved-seat ticket types get a seat automatically at issuance, under a row
--     lock that skips seats another transaction is taking; seat moves are audited.
--  5. Ticket types: entry window override, entry policy (single entry, or re-entry with a limit), seating (none / reserved).
--  6. Tickets: a public reference (VT-XXXX-XXXX, not a credential), a credential version that changes on transfer and reissue
--     (old static codes and old QR tokens stop working), entry counters and an inside/outside state for re-entry.
--  7. ticket_admissions: append-only entries and exits; a unique index makes a second successful single-use entry impossible.
--  8. Door teams: role scanner / supervisor, optional gate restriction, optional expiry. Scanner sessions per device,
--     revocable by the organiser.
--  9. admission_scan(): the one decision function. Checks, in order: signed in → scanner session live and allowed for this
--     event and gate → credential parses and verifies → ticket exists → exact event match → event status → ticket status →
--     payment → session → entry window → gate/zone → seat → prior use / re-entry → admit atomically. Idempotent per
--     (scanner, request id). admit_ticket() and check_in_ticket() now run through it, so no older path skips a rule.
-- 10. admission_override() for supervisors (manual review, reason required, audited); seat assignment; ticket revoke and
--     reissue; organiser dashboard numbers; holder-facing ticket details.
-- Additive. Rollback: drop the new functions/tables/columns and restore admit_ticket / check_in_ticket / my_ticket_qr /
-- transfer_ticket from migration 37 (and 6 for transfer_ticket).

-- ---------------------------------------------------------------- 1. events: status, entry window, schedule history
alter table public.events drop constraint if exists events_status_check;
alter table public.events add constraint events_status_check check (status in ('draft', 'active', 'postponed', 'cancelled', 'completed'));
alter table public.events add column if not exists doors_open_at timestamptz;
alter table public.events add column if not exists entry_closes_at timestamptz;
alter table public.events drop constraint if exists events_entry_window_check;
alter table public.events add constraint events_entry_window_check check (entry_closes_at is null or doors_open_at is null or entry_closes_at > doors_open_at);

-- When an event moves (postponed to a new date), its door times move with it unless the organiser sets them in the same change.
create or replace function public.trg_event_window_shift() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.starts_at is distinct from old.starts_at then
    if new.doors_open_at is not distinct from old.doors_open_at and old.doors_open_at is not null then
      new.doors_open_at := old.doors_open_at + (new.starts_at - old.starts_at);
    end if;
    if new.entry_closes_at is not distinct from old.entry_closes_at and old.entry_closes_at is not null then
      new.entry_closes_at := old.entry_closes_at + (new.starts_at - old.starts_at);
    end if;
  end if;
  return new;
end $$;
drop trigger if exists event_window_shift on public.events;
create trigger event_window_shift before update of starts_at on public.events for each row execute function public.trg_event_window_shift();
grant insert (doors_open_at, entry_closes_at) on public.events to authenticated;
grant update (doors_open_at, entry_closes_at) on public.events to authenticated;

-- Defaults when an organiser sets no window: doors 6 h before the start, entry until the end (or 12 h after the start).
alter table public.platform_config add column if not exists default_doors_lead interval not null default interval '6 hours';
alter table public.platform_config add column if not exists default_entry_span interval not null default interval '12 hours';

create table if not exists public.event_schedule_changes (
  id bigint generated always as identity primary key,
  event_id uuid not null references public.events(id) on delete cascade,
  changed_by uuid references public.profiles(id) on delete set null,
  old_status text, new_status text,
  old_starts_at timestamptz, new_starts_at timestamptz,
  old_ends_at timestamptz, new_ends_at timestamptz,
  old_doors_open_at timestamptz, new_doors_open_at timestamptz,
  old_entry_closes_at timestamptz, new_entry_closes_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists event_schedule_changes_event_idx on public.event_schedule_changes (event_id, created_at desc);
alter table public.event_schedule_changes enable row level security;
drop policy if exists esc_read on public.event_schedule_changes;
create policy esc_read on public.event_schedule_changes for select to authenticated using (public.can_manage_event(event_id) or public.is_admin());
revoke all on public.event_schedule_changes from anon, authenticated;
grant select on public.event_schedule_changes to authenticated;

create or replace function public.trg_event_schedule_history() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (old.status, old.starts_at, old.ends_at, old.doors_open_at, old.entry_closes_at) is distinct from
     (new.status, new.starts_at, new.ends_at, new.doors_open_at, new.entry_closes_at) then
    insert into public.event_schedule_changes (event_id, changed_by, old_status, new_status, old_starts_at, new_starts_at, old_ends_at, new_ends_at,
                                               old_doors_open_at, new_doors_open_at, old_entry_closes_at, new_entry_closes_at)
    values (new.id, auth.uid(), old.status, new.status, old.starts_at, new.starts_at, old.ends_at, new.ends_at,
            old.doors_open_at, new.doors_open_at, old.entry_closes_at, new.entry_closes_at);
    -- Postponing (and bringing a postponed event back) tells every ticket holder; date moves are already announced by the
    -- material-change trigger of migration 29.
    if old.status is distinct from new.status and 'postponed' in (old.status, new.status) then
      perform public.notify_ticket_holders(new.id, 'schedule:' || new.id || ':' || new.status || ':' || extract(epoch from now())::bigint);
    end if;
  end if;
  return new;
end $$;
drop trigger if exists event_schedule_history on public.events;
create trigger event_schedule_history after update on public.events for each row execute function public.trg_event_schedule_history();

-- ---------------------------------------------------------------- 2. sessions
create table if not exists public.event_sessions (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 60),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  doors_open_at timestamptz,
  entry_closes_at timestamptz,
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  check (ends_at > starts_at),
  check (doors_open_at is null or doors_open_at <= starts_at),
  check (entry_closes_at is null or entry_closes_at > coalesce(doors_open_at, starts_at - interval '7 days'))
);
create index if not exists event_sessions_event_idx on public.event_sessions (event_id, starts_at);

create table if not exists public.ticket_type_sessions (
  ticket_type_id uuid not null references public.ticket_types(id) on delete cascade,
  session_id uuid not null references public.event_sessions(id) on delete cascade,
  primary key (ticket_type_id, session_id)
);

-- ---------------------------------------------------------------- 3. zones and gates
create table if not exists public.event_zones (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 60),
  kind text not null default 'general' check (kind in ('general', 'standing', 'seated', 'vip', 'vvip', 'lounge', 'backstage', 'accessible', 'table', 'other')),
  capacity integer check (capacity is null or capacity > 0),
  created_at timestamptz not null default now(),
  unique (event_id, name)
);
create index if not exists event_zones_event_idx on public.event_zones (event_id);

create table if not exists public.event_gates (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 60),
  -- Tickets whose type grants no zone (plain general admission) may use this gate unless the organiser says otherwise.
  admits_unzoned boolean not null default true,
  status text not null default 'open' check (status in ('open', 'closed')),
  created_at timestamptz not null default now(),
  unique (event_id, name)
);
create index if not exists event_gates_event_idx on public.event_gates (event_id);

create table if not exists public.gate_zones (
  gate_id uuid not null references public.event_gates(id) on delete cascade,
  zone_id uuid not null references public.event_zones(id) on delete cascade,
  primary key (gate_id, zone_id)
);
create table if not exists public.ticket_type_zones (
  ticket_type_id uuid not null references public.ticket_types(id) on delete cascade,
  zone_id uuid not null references public.event_zones(id) on delete cascade,
  primary key (ticket_type_id, zone_id)
);

-- A link may only join things of the same event (a gate of event A can never serve a zone of event B).
create or replace function public.trg_same_event_link() returns trigger
language plpgsql security definer set search_path = '' as $$
declare a uuid; b uuid;
begin
  if tg_table_name = 'gate_zones' then
    select event_id into a from public.event_gates where id = new.gate_id; select event_id into b from public.event_zones where id = new.zone_id;
  elsif tg_table_name = 'ticket_type_zones' then
    select event_id into a from public.ticket_types where id = new.ticket_type_id; select event_id into b from public.event_zones where id = new.zone_id;
  else
    select event_id into a from public.ticket_types where id = new.ticket_type_id; select event_id into b from public.event_sessions where id = new.session_id;
  end if;
  if a is null or b is null or a <> b then raise exception 'Both sides must belong to the same event' using errcode = '23514'; end if;
  return new;
end $$;
drop trigger if exists same_event on public.gate_zones;
create trigger same_event before insert or update on public.gate_zones for each row execute function public.trg_same_event_link();
drop trigger if exists same_event on public.ticket_type_zones;
create trigger same_event before insert or update on public.ticket_type_zones for each row execute function public.trg_same_event_link();
drop trigger if exists same_event on public.ticket_type_sessions;
create trigger same_event before insert or update on public.ticket_type_sessions for each row execute function public.trg_same_event_link();

-- ---------------------------------------------------------------- 4. seats
create table if not exists public.event_seats (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  zone_id uuid references public.event_zones(id) on delete set null,
  section text not null check (char_length(btrim(section)) between 1 and 20),
  row_label text not null default '' check (char_length(row_label) <= 10),
  seat_number text not null check (char_length(btrim(seat_number)) between 1 and 10),
  accessible boolean not null default false,
  status text not null default 'open' check (status in ('open', 'blocked')),
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  unique (event_id, section, row_label, seat_number)
);
create index if not exists event_seats_event_idx on public.event_seats (event_id, zone_id, sort);

create or replace function public.seat_label(s public.event_seats) returns text
language sql immutable set search_path = '' as $$
  select 'Section ' || s.section || case when s.row_label <> '' then ' · Row ' || s.row_label else '' end || ' · Seat ' || s.seat_number;
$$;

-- ---------------------------------------------------------------- 5. ticket types: window, entry policy, seating
alter table public.ticket_types add column if not exists entry_opens_at timestamptz;
alter table public.ticket_types add column if not exists entry_closes_at timestamptz;
alter table public.ticket_types add column if not exists entry_policy text not null default 'single' check (entry_policy in ('single', 'reentry'));
alter table public.ticket_types add column if not exists max_entries integer check (max_entries is null or max_entries between 1 and 50);
alter table public.ticket_types add column if not exists seating text not null default 'none' check (seating in ('none', 'reserved'));
alter table public.ticket_types drop constraint if exists ticket_types_entry_window_check;
alter table public.ticket_types add constraint ticket_types_entry_window_check check (entry_closes_at is null or entry_opens_at is null or entry_closes_at > entry_opens_at);
grant insert (entry_opens_at, entry_closes_at, entry_policy, max_entries, seating) on public.ticket_types to authenticated;
grant update (entry_opens_at, entry_closes_at, entry_policy, max_entries, seating) on public.ticket_types to authenticated;

-- Inventory may not promise more admissions than the event's capacity (checked when ticket types are added or grown).
create or replace function public.trg_inventory_capacity() returns trigger
language plpgsql security definer set search_path = '' as $$
declare cap integer; total bigint;
begin
  select capacity into cap from public.events where id = new.event_id;
  if cap is null then return new; end if;
  if tg_op = 'UPDATE' and new.quantity_total * new.group_size <= old.quantity_total * old.group_size then return new; end if;
  select coalesce(sum(quantity_total * group_size), 0) into total from public.ticket_types where event_id = new.event_id and id <> new.id;
  if total + new.quantity_total * new.group_size > cap then
    raise exception 'Ticket quantities (%) would exceed the event capacity (%)', total + new.quantity_total * new.group_size, cap using errcode = '23514';
  end if;
  return new;
end $$;
drop trigger if exists inventory_capacity on public.ticket_types;
create trigger inventory_capacity before insert or update of quantity_total, group_size on public.ticket_types for each row execute function public.trg_inventory_capacity();

-- ---------------------------------------------------------------- 6. tickets: reference, seat, credential version, entries
create or replace function public.new_ticket_ref() returns text
language plpgsql volatile security definer set search_path = '' as $$
-- 8 characters from a 31-letter alphabet without look-alikes (no 0/O, 1/I/L): for people to read out, never a credential.
declare r text;
begin
  loop
    select 'VT-' || string_agg(substr('23456789ABCDEFGHJKMNPQRSTUVWXYZ', 1 + (get_byte(b, i) % 31), 1), '' order by i) filter (where i < 4) || '-' ||
                    string_agg(substr('23456789ABCDEFGHJKMNPQRSTUVWXYZ', 1 + (get_byte(b, i) % 31), 1), '' order by i) filter (where i >= 4)
      into r from (select decode(md5(gen_random_uuid()::text), 'hex') b) x, generate_series(0, 7) i;
    exit when not exists (select 1 from public.tickets where ref = r);
  end loop;
  return r;
end $$;
alter table public.tickets add column if not exists ref text;
update public.tickets set ref = public.new_ticket_ref() where ref is null;
alter table public.tickets alter column ref set default public.new_ticket_ref();
alter table public.tickets alter column ref set not null;
create unique index if not exists tickets_ref_key on public.tickets (ref);
alter table public.tickets add column if not exists seat_id uuid references public.event_seats(id) on delete restrict;
create unique index if not exists tickets_live_seat_key on public.tickets (seat_id) where seat_id is not null and status in ('valid', 'used');
alter table public.tickets add column if not exists qr_version integer not null default 0 check (qr_version >= 0);
alter table public.tickets add column if not exists entries integer not null default 0 check (entries >= 0);
alter table public.tickets add column if not exists inside boolean not null default false;
alter table public.tickets add column if not exists revoked_reason text check (revoked_reason is null or char_length(revoked_reason) <= 300);

create table if not exists public.ticket_seat_changes (
  id bigint generated always as identity primary key,
  ticket_id uuid not null references public.tickets(id) on delete cascade,
  old_seat uuid references public.event_seats(id) on delete set null,
  new_seat uuid references public.event_seats(id) on delete set null,
  changed_by uuid references public.profiles(id) on delete set null,
  reason text not null default '' check (char_length(reason) <= 300),
  created_at timestamptz not null default now()
);
alter table public.ticket_seat_changes enable row level security;
drop policy if exists tsc_read on public.ticket_seat_changes;
create policy tsc_read on public.ticket_seat_changes for select to authenticated
  using (public.is_admin() or exists (select 1 from public.tickets t where t.id = ticket_id and public.can_manage_event(t.event_id)));
revoke all on public.ticket_seat_changes from anon, authenticated;
grant select on public.ticket_seat_changes to authenticated;

-- Reserved-seat ticket types get the next open seat of their zones at issuance (whatever path issues the ticket). Seats another
-- transaction is assigning right now are skipped, and the unique index above is the last line of defence. If none is left the
-- ticket is issued without one and the door sends it to manual review; organisers see unseated tickets on the dashboard.
create or replace function public.trg_ticket_seat() returns trigger
language plpgsql security definer set search_path = '' as $$
declare tt public.ticket_types; sid uuid; tried uuid[] := '{}';
begin
  if new.seat_id is not null then return new; end if;
  select * into tt from public.ticket_types where id = new.ticket_type_id;
  if tt.seating <> 'reserved' then return new; end if;
  loop
    select s.id into sid from public.event_seats s
     where s.event_id = new.event_id and s.status = 'open' and s.id <> all (tried)
       and (not exists (select 1 from public.ticket_type_zones z where z.ticket_type_id = tt.id)
            or s.zone_id in (select z.zone_id from public.ticket_type_zones z where z.ticket_type_id = tt.id))
       and not exists (select 1 from public.tickets t where t.seat_id = s.id and t.status in ('valid', 'used'))
     order by s.accessible, s.sort, s.section, s.row_label, lpad(s.seat_number, 10, '0')
     limit 1 for update skip locked;
    exit when sid is null;
    -- The seat lock may have been granted only because another transaction just committed a ticket on it, which the search
    -- above (an older snapshot) could not see. This query takes a fresh snapshot: if the seat is now taken, try the next.
    exit when not exists (select 1 from public.tickets t where t.seat_id = sid and t.status in ('valid', 'used'));
    tried := tried || sid; sid := null;
  end loop;
  new.seat_id := sid;
  return new;
end $$;
drop trigger if exists ticket_seat on public.tickets;
create trigger ticket_seat before insert on public.tickets for each row execute function public.trg_ticket_seat();

-- ---------------------------------------------------------------- 7. admissions (append-only)
create table if not exists public.ticket_admissions (
  id bigint generated always as identity primary key,
  ticket_id uuid not null references public.tickets(id) on delete cascade,
  event_id uuid not null references public.events(id) on delete cascade,
  session_id uuid references public.event_sessions(id) on delete set null,
  gate_id uuid references public.event_gates(id) on delete set null,
  direction text not null check (direction in ('in', 'out')),
  single_use boolean not null,
  override boolean not null default false,
  scanner uuid references public.profiles(id) on delete set null,
  scan_session_id uuid,
  request_id uuid,
  created_at timestamptz not null default now()
);
-- The guarantee: one successful single-use entry per ticket (per session for session tickets), whatever path tries.
create unique index if not exists ticket_admissions_once on public.ticket_admissions
  (ticket_id, coalesce(session_id, '00000000-0000-0000-0000-000000000000'::uuid)) where single_use and direction = 'in';
create index if not exists ticket_admissions_event_idx on public.ticket_admissions (event_id, created_at desc);
create index if not exists ticket_admissions_ticket_idx on public.ticket_admissions (ticket_id, created_at desc);
create index if not exists tickets_inside_idx on public.tickets (event_id) where inside;
alter table public.ticket_admissions enable row level security;
drop policy if exists ta_read on public.ticket_admissions;
create policy ta_read on public.ticket_admissions for select to authenticated using (public.is_admin() or public.can_manage_event(event_id));
revoke all on public.ticket_admissions from anon, authenticated;
grant select on public.ticket_admissions to authenticated;

-- Nobody (organisers included) may rewrite or remove admission history.
-- The only change allowed is a reference becoming NULL because the profile, gate or seat it pointed to was deleted.
create or replace function public.trg_append_only() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and not exists (
       select 1 from jsonb_each(to_jsonb(new)) n join jsonb_each(to_jsonb(old)) o using (key)
        where n.value is distinct from o.value and n.value <> 'null'::jsonb) then
    return new;
  end if;
  raise exception '% is append-only', tg_table_name using errcode = '42501';
end $$;
drop trigger if exists append_only on public.ticket_admissions;
create trigger append_only before update or delete on public.ticket_admissions for each row execute function public.trg_append_only();
drop trigger if exists append_only on public.event_schedule_changes;
create trigger append_only before update or delete on public.event_schedule_changes for each row execute function public.trg_append_only();
drop trigger if exists append_only on public.ticket_seat_changes;
create trigger append_only before update or delete on public.ticket_seat_changes for each row execute function public.trg_append_only();

-- Tickets already redeemed before this migration count as one entry.
insert into public.ticket_admissions (ticket_id, event_id, direction, single_use, scanner, created_at)
select t.id, t.event_id, 'in', true, t.used_by, coalesce(t.used_at, now()) from public.tickets t
 where t.status = 'used' and not exists (select 1 from public.ticket_admissions a where a.ticket_id = t.id);
update public.tickets set entries = 1 where status = 'used' and entries = 0;

-- ---------------------------------------------------------------- 8. door teams and scanner sessions
alter table public.event_staff drop constraint if exists event_staff_role_check;
alter table public.event_staff add constraint event_staff_role_check check (role in ('scanner', 'supervisor'));
alter table public.event_staff add column if not exists gate_id uuid references public.event_gates(id) on delete set null;
alter table public.event_staff add column if not exists expires_at timestamptz;
grant insert (gate_id, expires_at) on public.event_staff to authenticated;
grant update (role, gate_id, expires_at) on public.event_staff to authenticated;
drop policy if exists event_staff_upd on public.event_staff;
create policy event_staff_upd on public.event_staff for update to authenticated using (public.can_manage_event(event_id)) with check (public.can_manage_event(event_id));

create or replace function public.trg_staff_gate() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.gate_id is not null and not exists (select 1 from public.event_gates g where g.id = new.gate_id and g.event_id = new.event_id) then
    raise exception 'That gate belongs to another event' using errcode = '23514';
  end if;
  return new;
end $$;
drop trigger if exists staff_gate on public.event_staff;
create trigger staff_gate before insert or update on public.event_staff for each row execute function public.trg_staff_gate();

-- Door access, now honouring expiry. Managers (host, org owner/admin/editor) are supervisors on every gate.
create or replace function public.can_scan_event(eid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.can_manage_event(eid) or exists (select 1 from public.event_staff s where s.event_id = eid and s.user_id = auth.uid()
                                                   and (s.expires_at is null or s.expires_at > now()));
$$;

-- 'manager' | 'supervisor' | 'scanner' | null, and the gate a scanner is limited to.
create or replace function public.door_role(eid uuid, out role text, out gate uuid)
language plpgsql stable security definer set search_path = '' as $$
begin
  if public.can_manage_event(eid) then role := 'manager'; gate := null; return; end if;
  select s.role, s.gate_id into role, gate from public.event_staff s
   where s.event_id = eid and s.user_id = auth.uid() and (s.expires_at is null or s.expires_at > now());
end $$;

create table if not exists public.scan_sessions (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  gate_id uuid references public.event_gates(id) on delete set null,
  session_id uuid references public.event_sessions(id) on delete set null,
  scanner uuid not null references public.profiles(id) on delete cascade,
  device_label text not null default '' check (char_length(device_label) <= 60),
  started_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  ended_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid references public.profiles(id) on delete set null
);
create index if not exists scan_sessions_event_idx on public.scan_sessions (event_id, started_at desc);
create index if not exists scan_sessions_scanner_idx on public.scan_sessions (scanner, started_at desc);
alter table public.scan_sessions enable row level security;
drop policy if exists ss_read on public.scan_sessions;
create policy ss_read on public.scan_sessions for select to authenticated using (scanner = (select auth.uid()) or public.can_manage_event(event_id) or public.is_admin());
revoke all on public.scan_sessions from anon, authenticated;
grant select on public.scan_sessions to authenticated;

-- ---------------------------------------------------------------- 9. scan log: richer, idempotent
alter table public.ticket_scans add column if not exists gate_id uuid references public.event_gates(id) on delete set null;
alter table public.ticket_scans add column if not exists scan_session_id uuid references public.scan_sessions(id) on delete set null;
alter table public.ticket_scans add column if not exists session_id uuid references public.event_sessions(id) on delete set null;
alter table public.ticket_scans add column if not exists request_id uuid;
alter table public.ticket_scans add column if not exists decision text;
alter table public.ticket_scans add column if not exists response jsonb;
create unique index if not exists ticket_scans_request_key on public.ticket_scans (scanner, request_id) where request_id is not null;
create index if not exists ticket_scans_ticket_idx on public.ticket_scans (ticket_id, created_at desc) where ticket_id is not null;
alter table public.ticket_scans drop constraint if exists ticket_scans_result_check;
alter table public.ticket_scans add constraint ticket_scans_result_check check (result in (
  'ok', 'already_used', 'void', 'refunded', 'wrong_event', 'invalid', 'forbidden', 'event_cancelled', 'not_paid', 'rate_limited',
  'expired_qr', 'static_code', 'not_yet_valid', 'expired', 'wrong_gate', 'event_postponed', 'manual_review', 'wrong_session', 'exit', 'override'));

-- ---------------------------------------------------------------- 10. QR credentials: versioned
-- VYBE3:<ticket id>:<credential version>:<30 s window>:<signature>. Transfer and reissue raise the version, so every token and
-- static code held before stops working. VYBE2 tokens (migration 37) remain valid only at version 0.
-- The signature is keyed by a per-ticket key derived from the server-only secret: k = SHA-256(secret, ticket, version),
-- sig = first 80 bits of SHA-256(k, window). The server never hands out the secret. An offline scanner (migration 44) can be
-- given the per-ticket keys of ONE event so it can check tokens without a connection; a leaked manifest exposes only that
-- event's tickets, and the version bump on transfer/reissue/revoke retires them.
create or replace function public.ticket_key3(tid uuid, ver integer) returns text
language sql stable security definer set search_path = '' as $$
  select encode(sha256(convert_to((select secret from public.qr_secret) || ':k3:' || tid::text || ':' || ver::text, 'utf8')), 'hex');
$$;
revoke execute on function public.ticket_key3(uuid, integer) from public, anon, authenticated;
create or replace function public.qr_sig3(tid uuid, ver integer, win bigint) returns text
language sql stable security definer set search_path = '' as $$
  select substr(encode(sha256(convert_to(public.ticket_key3(tid, ver) || ':' || win::text, 'utf8')), 'hex'), 1, 20);
$$;
revoke execute on function public.qr_sig3(uuid, integer, bigint) from public, anon, authenticated;

-- Holders get tokens for valid tickets, and for used ones that still admit (re-entry, later sessions).
create or replace function public.ticket_still_admits(t public.tickets) returns boolean
language sql stable security definer set search_path = '' as $$
  select t.status = 'valid' or (t.status = 'used' and exists (
    select 1 from public.ticket_types tt where tt.id = t.ticket_type_id
       and (tt.entry_policy = 'reentry' or exists (select 1 from public.ticket_type_sessions s where s.ticket_type_id = tt.id))));
$$;
revoke execute on function public.ticket_still_admits(public.tickets) from public, anon, authenticated;

create or replace function public.my_ticket_qr(p_ticket uuid, p_count integer default 1) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare t public.tickets; cfg public.platform_config; w bigint := floor(extract(epoch from now()) / 30)::bigint;
        n integer := greatest(1, least(coalesce(p_count, 1), 24)); out jsonb := '[]'::jsonb;
begin
  select * into t from public.tickets where id = p_ticket and owner = auth.uid();
  if not found or not public.ticket_still_admits(t) then return null; end if;
  select * into cfg from public.platform_config where id;
  for i in 0..n - 1 loop
    out := out || jsonb_build_array(jsonb_build_object('w', w + i,
      'token', 'VYBE3:' || t.id::text || ':' || t.qr_version || ':' || (w + i)::text || ':' || public.qr_sig3(t.id, t.qr_version, w + i)));
  end loop;
  return jsonb_build_object('tokens', out, 'step_seconds', 30, 'static_ok', not cfg.require_rotating_qr, 'server_epoch', floor(extract(epoch from now()))::bigint);
end $$;

-- ---------------------------------------------------------------- 11. the decision
-- Entry window for a ticket (and a session, if any): explicit settings first, then the platform defaults.
create or replace function public.entry_window(ev public.events, tt public.ticket_types, s public.event_sessions, out opens timestamptz, out closes timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare cfg public.platform_config;
begin
  select * into cfg from public.platform_config where id;
  if s.id is not null then
    opens := coalesce(tt.entry_opens_at, s.doors_open_at, s.starts_at - cfg.default_doors_lead);
    closes := coalesce(tt.entry_closes_at, s.entry_closes_at, s.ends_at);
  else
    opens := coalesce(tt.entry_opens_at, ev.doors_open_at, ev.starts_at - cfg.default_doors_lead);
    closes := coalesce(tt.entry_closes_at, ev.entry_closes_at, ev.ends_at, ev.starts_at + cfg.default_entry_span);
  end if;
end $$;
revoke execute on function public.entry_window(public.events, public.ticket_types, public.event_sessions) from public, anon, authenticated;

create or replace function public.decision_message(d text) returns text
language sql immutable set search_path = '' as $$
  select case d
    when 'ACCEPTED' then 'ADMIT'
    when 'EXITED' then 'EXIT RECORDED'
    when 'WRONG_EVENT' then 'WRONG EVENT — DENY'
    when 'NOT_YET_VALID' then 'NOT YET VALID — DENY'
    when 'EXPIRED' then 'ENTRY CLOSED — DENY'
    when 'ALREADY_USED' then 'ALREADY USED — DENY'
    when 'INVALID' then 'INVALID TICKET — DENY'
    when 'REVOKED' then 'CANCELLED / REFUNDED / REVOKED — DENY'
    when 'WRONG_GATE_OR_ZONE' then 'WRONG GATE OR ZONE — DENY'
    when 'WRONG_SESSION' then 'NOT FOR THIS SESSION — DENY'
    when 'PAYMENT_NOT_CONFIRMED' then 'PAYMENT NOT CONFIRMED — DENY'
    when 'EVENT_CANCELLED' then 'EVENT CANCELLED — DENY'
    when 'EVENT_POSTPONED' then 'EVENT POSTPONED — DENY'
    when 'MANUAL_REVIEW' then 'MANUAL REVIEW — HOLD'
    when 'QR_EXPIRED' then 'QR EXPIRED — ASK THEM TO REOPEN THE TICKET'
    when 'STATIC_CODE' then 'OLD CODE — ASK THEM TO OPEN THE TICKET IN VYBE'
    when 'FORBIDDEN' then 'NOT AUTHORISED FOR THIS EVENT OR GATE'
    when 'RATE_LIMITED' then 'TOO MANY FAILED SCANS — WAIT A MOMENT'
    else d end;
$$;

-- Internal core. p_scan_session may be null only for the legacy wrappers (managers and gate-free staff).
create or replace function public.admission_core(p_event uuid, p_gate uuid, p_session uuid, p_scan_session uuid, p_credential text,
                                                 p_request uuid, p_mode text, p_override_reason text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid(); ev public.events; dr record; g public.event_gates; s public.event_sessions; t public.tickets; tt public.ticket_types;
  o public.orders; other public.events; seat public.event_seats; cfg public.platform_config; prev public.ticket_scans;
  raw text := btrim(coalesce(p_credential, '')); c text; parts text[]; tid uuid; win bigint; ver integer;
  cur bigint := floor(extract(epoch from now()) / 30)::bigint; token_old boolean := false; by_ref boolean := false;
  d text; res jsonb; detail jsonb := '{}'::jsonb; w record; sessions_n integer; type_zones uuid[]; zone_names text[]; holder text;
  last_dir text; first_at timestamptz; first_gate text; legacy text; single boolean;
begin
  if me is null then raise exception 'Sign in' using errcode = '28000'; end if;
  if p_mode not in ('entry', 'exit') then raise exception 'bad mode'; end if;

  -- Idempotency: the same request from the same scanner always gets the same answer, and never redeems twice.
  if p_request is not null then
    select * into prev from public.ticket_scans where scanner = me and request_id = p_request;
    if found then return coalesce(prev.response, jsonb_build_object('decision', prev.decision)) || jsonb_build_object('replay', true); end if;
  end if;

  select * into ev from public.events where id = p_event;
  select * into dr from public.door_role(p_event);
  if not found or ev.id is null or dr.role is null
     or (dr.gate is not null and p_gate is distinct from dr.gate)
     or (p_gate is not null and not exists (select 1 from public.event_gates x where x.id = p_gate and x.event_id = p_event))
     or (p_gate is null and dr.role = 'scanner' and exists (select 1 from public.event_gates x where x.event_id = p_event)) then
    d := 'FORBIDDEN';
  elsif p_override_reason is not null and dr.role not in ('manager', 'supervisor') then
    d := 'FORBIDDEN';
  end if;
  if d is null and p_scan_session is not null and not exists (
       select 1 from public.scan_sessions x where x.id = p_scan_session and x.scanner = me and x.event_id = p_event
          and x.gate_id is not distinct from p_gate and x.ended_at is null and x.revoked_at is null) then
    d := 'FORBIDDEN';
  end if;
  if d = 'FORBIDDEN' then
    insert into public.ticket_scans (event_id, scanner, result, decision, gate_id, scan_session_id, request_id, response)
    values (case when ev.id is not null then p_event end, me, 'forbidden', d, null, null, p_request,
            jsonb_build_object('decision', d, 'admit', false, 'message', public.decision_message(d)))
    on conflict do nothing;
    return jsonb_build_object('decision', d, 'admit', false, 'message', public.decision_message(d));
  end if;
  if p_scan_session is not null then update public.scan_sessions set last_seen_at = now() where id = p_scan_session; end if;
  if p_gate is not null then select * into g from public.event_gates where id = p_gate; end if;
  if p_session is not null then
    select * into s from public.event_sessions where id = p_session and event_id = p_event;
    if not found then raise exception 'That session is not part of this event'; end if;
  end if;

  if (select count(*) from public.ticket_scans where scanner = me and result in ('invalid', 'wrong_event') and created_at > now() - interval '5 minutes') >= 40 then
    d := 'RATE_LIMITED';
  end if;
  select * into cfg from public.platform_config where id;

  -- Credential → ticket. The scanner's claims about category, seat or event are never read: only the credential.
  if d is null then
    if upper(raw) like 'VYBE3:%' or upper(raw) like 'VYBE2:%' then
      parts := string_to_array(raw, ':');
      if upper(parts[1]) = 'VYBE3' and cardinality(parts) = 5 and lower(parts[2]) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         and parts[3] ~ '^[0-9]{1,6}$' and parts[4] ~ '^[0-9]{1,12}$' then
        tid := lower(parts[2])::uuid; ver := parts[3]::integer; win := parts[4]::bigint;
        if public.qr_sig3(tid, ver, win) <> lower(parts[5]) then d := 'INVALID'; end if;
      elsif upper(parts[1]) = 'VYBE2' and cardinality(parts) = 4 and lower(parts[2]) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' and parts[3] ~ '^[0-9]{1,12}$' then
        tid := lower(parts[2])::uuid; ver := 0; win := parts[3]::bigint;
        if public.qr_sig(tid, win) <> lower(parts[4]) then d := 'INVALID'; end if;
      else
        d := 'INVALID';
      end if;
      if d is null then
        token_old := abs(cur - win) > 1;
        select * into t from public.tickets where id = tid for update;
        if found and t.qr_version <> ver then d := 'INVALID'; detail := detail || jsonb_build_object('reason', 'replaced credential'); end if;
      end if;
    elsif upper(raw) ~ '^VT-?[23456789A-HJKMNP-Z]{4}-?[23456789A-HJKMNP-Z]{4}$' then
      -- A ticket reference typed by hand: a lookup, not a credential. Supervisors only; it always needs a person to check ID.
      by_ref := true;
      if dr.role not in ('manager', 'supervisor') then d := 'FORBIDDEN';
      else
        c := upper(regexp_replace(raw, '[^A-Za-z0-9]', '', 'g'));
        select * into t from public.tickets where ref = 'VT-' || substr(c, 3, 4) || '-' || substr(c, 7, 4) for update;
      end if;
    else
      c := upper(regexp_replace(raw, '[^A-Za-z0-9]', '', 'g'));
      if cfg.require_rotating_qr then d := 'STATIC_CODE';
      else
        if c like 'VYBE1%' then c := substr(c, 6); end if;
        select * into t from public.tickets where code = c for update;
      end if;
    end if;
    if d is null and t.id is null then d := 'INVALID'; end if;
  end if;

  -- Exact event identity. Same date, same venue or a similar name never matters.
  if d is null and t.event_id <> p_event then
    d := 'WRONG_EVENT';
    select * into other from public.events where id = t.event_id;
    detail := detail || jsonb_build_object('valid_for', case when other.visibility = 'public' then other.title else 'another event' end,
                                           'valid_for_starts_at', case when other.visibility = 'public' then other.starts_at end, 'scanned_at', ev.title);
  end if;
  if d is null then
    select * into tt from public.ticket_types where id = t.ticket_type_id;
    select * into o from public.orders where id = t.order_id;
    single := tt.entry_policy = 'single';
    if ev.status = 'cancelled' then d := 'EVENT_CANCELLED';
    elsif ev.status = 'postponed' then d := 'EVENT_POSTPONED';
    elsif t.status in ('void', 'refunded') then d := 'REVOKED'; detail := detail || jsonb_build_object('status', t.status);
    elsif o.status not in ('paid', 'partially_refunded') then d := 'PAYMENT_NOT_CONFIRMED';
    end if;
  end if;

  -- Session: the scanner's chosen one, or the one of this ticket type that is open now.
  if d is null then
    select count(*) into sessions_n from public.ticket_type_sessions x where x.ticket_type_id = tt.id;
    if sessions_n > 0 then
      if s.id is null then
        select es.* into s from public.event_sessions es join public.ticket_type_sessions x on x.session_id = es.id and x.ticket_type_id = tt.id
         order by (now() between coalesce(tt.entry_opens_at, es.doors_open_at, es.starts_at - cfg.default_doors_lead)
                              and coalesce(tt.entry_closes_at, es.entry_closes_at, es.ends_at)) desc,
                  abs(extract(epoch from (es.starts_at - now()))) limit 1;
      elsif not exists (select 1 from public.ticket_type_sessions x where x.ticket_type_id = tt.id and x.session_id = s.id) then
        d := 'WRONG_SESSION'; detail := detail || jsonb_build_object('session', s.name);
      end if;
    else
      s := null;            -- a whole-event ticket is checked against the event window even if the scanner picked a session
    end if;
  end if;

  if d is null and p_mode = 'entry' then
    select * into w from public.entry_window(ev, tt, s);
    if now() < w.opens then d := 'NOT_YET_VALID'; detail := detail || jsonb_build_object('opens_at', w.opens);
    elsif now() > w.closes then d := 'EXPIRED'; detail := detail || jsonb_build_object('closed_at', w.closes);
    end if;
  end if;

  -- Gate and zone: the ticket type's zones must meet the gate's, or the gate must take plain general admission.
  select coalesce(array_agg(z.zone_id), '{}'), coalesce(array_agg(ez.name order by ez.name), '{}') into type_zones, zone_names
    from public.ticket_type_zones z join public.event_zones ez on ez.id = z.zone_id where z.ticket_type_id = tt.id;
  if d is null and g.id is not null then
    if g.status = 'closed' then d := 'WRONG_GATE_OR_ZONE'; detail := detail || jsonb_build_object('reason', 'gate closed');
    elsif cardinality(type_zones) = 0 and not g.admits_unzoned then d := 'WRONG_GATE_OR_ZONE';
    elsif cardinality(type_zones) > 0 and exists (select 1 from public.gate_zones gz where gz.gate_id = g.id)
          and not exists (select 1 from public.gate_zones gz where gz.gate_id = g.id and gz.zone_id = any (type_zones)) then d := 'WRONG_GATE_OR_ZONE';
    end if;
  end if;

  if t.seat_id is not null then select * into seat from public.event_seats where id = t.seat_id; end if;

  -- Prior use, re-entry and exits.
  if d is null then
    select a.direction into last_dir from public.ticket_admissions a
     where a.ticket_id = t.id and a.session_id is not distinct from s.id order by a.id desc limit 1;
    select a.created_at, eg.name into first_at, first_gate from public.ticket_admissions a left join public.event_gates eg on eg.id = a.gate_id
     where a.ticket_id = t.id and a.direction = 'in' and a.session_id is not distinct from s.id order by a.id limit 1;
    if p_mode = 'exit' then
      if tt.entry_policy <> 'reentry' then d := 'MANUAL_REVIEW'; detail := detail || jsonb_build_object('reason', 'this ticket has no re-entry');
      elsif last_dir is distinct from 'in' then d := 'MANUAL_REVIEW'; detail := detail || jsonb_build_object('reason', 'not recorded as inside');
      else d := 'EXITED';
      end if;
    elsif single and (first_at is not null or (s.id is null and t.status = 'used')) then
      d := 'ALREADY_USED'; detail := detail || jsonb_build_object('used_at', coalesce(first_at, t.used_at), 'used_gate', first_gate);
    elsif not single and last_dir = 'in' then
      d := 'ALREADY_USED'; detail := detail || jsonb_build_object('used_at', first_at, 'used_gate', first_gate, 'reason', 'already inside');
    elsif not single and tt.max_entries is not null and t.entries >= tt.max_entries then
      d := 'ALREADY_USED'; detail := detail || jsonb_build_object('reason', 'entry limit reached', 'entries', t.entries);
    end if;
  end if;

  -- The venue is full: people inside (single-use entries never leave the count; re-entry exits do) at the event capacity.
  if d is null and p_mode = 'entry' and ev.capacity is not null
     and (select count(*) from public.tickets x where x.event_id = p_event and x.inside) >= ev.capacity then
    d := 'MANUAL_REVIEW'; detail := detail || jsonb_build_object('reason', 'venue at capacity');
  end if;
  -- Things a person has to resolve: a reserved-seat ticket without a seat, a hand-typed reference, an old QR.
  if d is null and tt.seating = 'reserved' and seat.id is null then d := 'MANUAL_REVIEW'; detail := detail || jsonb_build_object('reason', 'reserved seat not assigned'); end if;
  if d is null and by_ref then d := 'MANUAL_REVIEW'; detail := detail || jsonb_build_object('reason', 'reference typed by hand: check photo ID'); end if;
  if d is null and token_old then d := 'QR_EXPIRED'; end if;

  -- A supervisor may admit a ticket held for manual review (never one that is revoked, unpaid, used or for another event).
  if p_override_reason is not null and p_mode = 'entry' and (d is null or (d = 'MANUAL_REVIEW' and coalesce(detail->>'reason', '') <> 'venue at capacity')) then d := 'OVERRIDE'; end if;
  if p_override_reason is not null and d not in ('OVERRIDE', 'FORBIDDEN') then
    detail := detail || jsonb_build_object('override_refused', true);
  end if;

  if d is null or d = 'OVERRIDE' then
    -- Redeem atomically: the ticket row is locked; the unique index refuses a second single-use entry even on another path.
    insert into public.ticket_admissions (ticket_id, event_id, session_id, gate_id, direction, single_use, override, scanner, scan_session_id, request_id)
    values (t.id, p_event, s.id, g.id, 'in', single, coalesce(d = 'OVERRIDE', false), me, p_scan_session, p_request);
    update public.tickets set status = 'used', used_at = coalesce(used_at, now()), used_by = coalesce(used_by, me), entries = entries + 1, inside = true where id = t.id;
    if coalesce(d = 'OVERRIDE', false) then
      insert into public.audit_log (actor, action, entity_type, entity_id, detail)
      values (me, 'ticket.admission_override', 'ticket', t.id, jsonb_build_object('event', p_event, 'gate', g.id, 'reason', left(p_override_reason, 300)));
    end if;
    d := 'ACCEPTED';
  elsif d = 'EXITED' then
    insert into public.ticket_admissions (ticket_id, event_id, session_id, gate_id, direction, single_use, scanner, scan_session_id, request_id)
    values (t.id, p_event, s.id, g.id, 'out', false, me, p_scan_session, p_request);
    update public.tickets set inside = false where id = t.id;
  end if;

  if d = 'ACCEPTED' then select coalesce(nullif(display_name, ''), username) into holder from public.profiles where id = t.owner; end if;
  res := jsonb_build_object('decision', d, 'admit', d = 'ACCEPTED', 'message', public.decision_message(d), 'event', ev.title,
                            'gate', g.name, 'session', s.name, 'override', p_override_reason is not null and d = 'ACCEPTED') || detail;
  if t.id is not null and d not in ('INVALID', 'WRONG_EVENT', 'FORBIDDEN', 'RATE_LIMITED', 'STATIC_CODE') then
    res := res || jsonb_build_object('ticket', jsonb_build_object(
      'id', t.id, 'ref', t.ref, 'type', tt.name, 'tier', tt.tier, 'zones', to_jsonb(zone_names),
      'seat', case when seat.id is not null then public.seat_label(seat) when tt.seating = 'reserved' then 'Reserved seat not assigned yet' else 'General Admission — No reserved seat' end,
      'entry_policy', tt.entry_policy, 'entries', t.entries + case when d = 'ACCEPTED' then 1 else 0 end), 'holder', holder);
  end if;

  legacy := case d when 'ACCEPTED' then case when p_override_reason is not null then 'override' else 'ok' end
                   when 'EXITED' then 'exit' when 'ALREADY_USED' then 'already_used' when 'INVALID' then 'invalid'
                   when 'WRONG_EVENT' then 'wrong_event' when 'EVENT_CANCELLED' then 'event_cancelled' when 'EVENT_POSTPONED' then 'event_postponed'
                   when 'PAYMENT_NOT_CONFIRMED' then 'not_paid' when 'QR_EXPIRED' then 'expired_qr' when 'STATIC_CODE' then 'static_code'
                   when 'RATE_LIMITED' then 'rate_limited' when 'NOT_YET_VALID' then 'not_yet_valid' when 'EXPIRED' then 'expired'
                   when 'WRONG_GATE_OR_ZONE' then 'wrong_gate' when 'WRONG_SESSION' then 'wrong_session' when 'MANUAL_REVIEW' then 'manual_review'
                   when 'REVOKED' then case when t.status = 'refunded' then 'refunded' else 'void' end else 'invalid' end;
  insert into public.ticket_scans (event_id, ticket_id, scanner, result, decision, gate_id, scan_session_id, session_id, request_id, response)
  values (p_event, t.id, me, legacy, d, g.id, p_scan_session, s.id, p_request, res)
  on conflict do nothing;
  if not found and p_request is not null then        -- the same request raced in twice: answer with the first one's result
    select * into prev from public.ticket_scans where scanner = me and request_id = p_request;
    return coalesce(prev.response, res) || jsonb_build_object('replay', true);
  end if;
  return res;
end $$;
revoke execute on function public.admission_core(uuid, uuid, uuid, uuid, text, uuid, text, text) from public, anon, authenticated;

-- ---------------------------------------------------------------- 12. door API
create or replace function public.start_scan_session(p_event uuid, p_gate uuid default null, p_session uuid default null, p_device text default '') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare dr record; ev public.events; sid uuid; g public.event_gates; es public.event_sessions;
begin
  if auth.uid() is null then raise exception 'Sign in' using errcode = '28000'; end if;
  select * into ev from public.events where id = p_event;
  select * into dr from public.door_role(p_event);
  if ev.id is null or dr.role is null then raise exception 'You are not on the door team for this event' using errcode = '42501'; end if;
  if dr.gate is not null and p_gate is distinct from dr.gate then raise exception 'You are assigned to another gate' using errcode = '42501'; end if;
  if p_gate is not null then
    select * into g from public.event_gates where id = p_gate and event_id = p_event;
    if not found then raise exception 'That gate is not part of this event'; end if;
  elsif exists (select 1 from public.event_gates x where x.event_id = p_event) then
    raise exception 'Choose the gate you are working at';
  end if;
  if p_session is not null then
    select * into es from public.event_sessions where id = p_session and event_id = p_event;
    if not found then raise exception 'That session is not part of this event'; end if;
  end if;
  update public.scan_sessions set ended_at = now() where scanner = auth.uid() and event_id = p_event and ended_at is null and revoked_at is null;
  insert into public.scan_sessions (event_id, gate_id, session_id, scanner, device_label) values (p_event, p_gate, p_session, auth.uid(), left(coalesce(p_device, ''), 60))
  returning id into sid;
  insert into public.audit_log (actor, action, entity_type, entity_id, detail) values (auth.uid(), 'door.session_started', 'event', p_event, jsonb_build_object('session', sid, 'gate', p_gate));
  return jsonb_build_object('id', sid, 'role', dr.role, 'event', jsonb_build_object('id', ev.id, 'title', ev.title, 'starts_at', ev.starts_at, 'timezone', ev.timezone, 'venue', ev.venue, 'status', ev.status),
                            'gate', case when g.id is not null then jsonb_build_object('id', g.id, 'name', g.name) end,
                            'session', case when es.id is not null then jsonb_build_object('id', es.id, 'name', es.name) end,
                            'server_time', now());
end $$;

create or replace function public.end_scan_session(p_scan_session uuid) returns void
language sql security definer set search_path = '' as $$
  update public.scan_sessions set ended_at = now() where id = p_scan_session and scanner = auth.uid() and ended_at is null;
$$;

create or replace function public.revoke_scan_session(p_scan_session uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare x public.scan_sessions;
begin
  select * into x from public.scan_sessions where id = p_scan_session;
  if not found or not (public.can_manage_event(x.event_id) or public.is_admin()) then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.scan_sessions set revoked_at = now(), revoked_by = auth.uid() where id = x.id and revoked_at is null;
  insert into public.audit_log (actor, action, entity_type, entity_id, detail) values (auth.uid(), 'door.session_revoked', 'event', x.event_id, jsonb_build_object('session', x.id, 'scanner', x.scanner));
end $$;

-- The scanner screen calls this for every scan. The event, gate and session come from the scanner's own live session.
create or replace function public.admission_scan(p_scan_session uuid, p_credential text, p_request uuid, p_mode text default 'entry') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare x public.scan_sessions;
begin
  if auth.uid() is null then raise exception 'Sign in' using errcode = '28000'; end if;
  select * into x from public.scan_sessions where id = p_scan_session and scanner = auth.uid();
  if not found or x.ended_at is not null or x.revoked_at is not null then
    insert into public.ticket_scans (event_id, scanner, result, decision, request_id) values (x.event_id, auth.uid(), 'forbidden', 'FORBIDDEN', p_request) on conflict do nothing;
    return jsonb_build_object('decision', 'FORBIDDEN', 'admit', false, 'message', 'SCANNER SESSION ENDED — START AGAIN');
  end if;
  return public.admission_core(x.event_id, x.gate_id, x.session_id, x.id, p_credential, p_request, coalesce(p_mode, 'entry'));
end $$;

create or replace function public.admission_override(p_scan_session uuid, p_ticket uuid, p_request uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare x public.scan_sessions; t public.tickets;
begin
  if char_length(btrim(coalesce(p_reason, ''))) < 5 then raise exception 'Say why this ticket is being admitted'; end if;
  select * into x from public.scan_sessions where id = p_scan_session and scanner = auth.uid() and ended_at is null and revoked_at is null;
  if not found then raise exception 'Start a scanner session first' using errcode = '42501'; end if;
  select * into t from public.tickets where id = p_ticket;
  if not found then raise exception 'Ticket not found'; end if;
  -- The override re-runs every rule with the ticket's current credential version; only a manual-review hold can be lifted.
  return public.admission_core(x.event_id, x.gate_id, x.session_id, x.id,
    'VYBE3:' || t.id || ':' || t.qr_version || ':' || floor(extract(epoch from now()) / 30)::bigint || ':' || public.qr_sig3(t.id, t.qr_version, floor(extract(epoch from now()) / 30)::bigint),
    p_request, 'entry', btrim(p_reason));
end $$;

-- Older screens: event-bound, gate-free. Gate-restricted staff are refused here (they must use a gate session).
create or replace function public.admit_ticket(p_event uuid, p_code text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r jsonb; legacy text;
begin
  r := public.admission_core(p_event, null, null, null, p_code, null, 'entry');
  legacy := case r->>'decision' when 'ACCEPTED' then 'ok' when 'ALREADY_USED' then 'already_used' when 'INVALID' then 'invalid'
              when 'WRONG_EVENT' then 'wrong_event' when 'EVENT_CANCELLED' then 'event_cancelled' when 'EVENT_POSTPONED' then 'event_postponed'
              when 'PAYMENT_NOT_CONFIRMED' then 'not_paid' when 'QR_EXPIRED' then 'expired_qr' when 'STATIC_CODE' then 'static_code'
              when 'RATE_LIMITED' then 'rate_limited' when 'NOT_YET_VALID' then 'not_yet_valid' when 'EXPIRED' then 'expired'
              when 'WRONG_GATE_OR_ZONE' then 'wrong_gate' when 'WRONG_SESSION' then 'wrong_session' when 'MANUAL_REVIEW' then 'manual_review'
              when 'FORBIDDEN' then 'forbidden'
              when 'REVOKED' then case when r->>'status' = 'refunded' then 'refunded' else 'void' end else 'invalid' end;
  return jsonb_build_object('result', legacy, 'decision', r->>'decision', 'ticket_type', r#>>'{ticket,type}', 'holder', r->>'holder',
                            'used_at', r->'used_at', 'valid_for', r->'valid_for', 'opens_at', r->'opens_at', 'seat', r#>>'{ticket,seat}');
end $$;

create or replace function public.check_in_ticket(p_code text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare eid uuid; raw text := btrim(coalesce(p_code, '')); c text := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g')); r jsonb; parts text[];
begin
  if upper(raw) like 'VYBE3:%' or upper(raw) like 'VYBE2:%' then
    parts := string_to_array(raw, ':');
    if cardinality(parts) >= 4 and lower(parts[2]) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      select event_id into eid from public.tickets where id = lower(parts[2])::uuid;
    end if;
  else
    if c like 'VYBE1%' then c := substr(c, 6); end if;
    select event_id into eid from public.tickets where code = c;
  end if;
  if eid is null then
    insert into public.ticket_scans (scanner, result, decision) values (auth.uid(), 'invalid', 'INVALID');
    return jsonb_build_object('result', 'invalid');
  end if;
  r := public.admit_ticket(eid, raw);
  return case when r->>'result' = 'already_used' then r || jsonb_build_object('result', 'used') else r end;
end $$;

-- ---------------------------------------------------------------- 13. organiser operations
-- Every credential the old holder had stops working on transfer: new static code, new QR version.
create or replace function public.transfer_ticket(p_ticket uuid, p_to uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare t public.tickets; ev public.events;
begin
  select * into t from public.tickets where id = p_ticket for update;
  if not found or t.owner <> auth.uid() then raise exception 'Ticket not found'; end if;
  if t.status <> 'valid' or t.entries > 0 then raise exception 'This ticket can no longer be transferred'; end if;
  if t.transfers >= 1 then raise exception 'This ticket has already been transferred once'; end if;
  select * into ev from public.events where id = t.event_id;
  if coalesce(ev.ends_at, ev.starts_at + interval '6 hours') < now() then raise exception 'This event has ended'; end if;
  if p_to = auth.uid() or not public.are_friends(auth.uid(), p_to) then raise exception 'You can only transfer tickets to friends'; end if;
  update public.tickets set owner = p_to, transfers = transfers + 1, qr_version = qr_version + 1,
         code = upper(substr(md5(gen_random_uuid()::text || gen_random_uuid()::text), 1, 20)) where id = p_ticket;
  insert into public.audit_log (actor, action, entity_type, entity_id, detail) values (auth.uid(), 'ticket.transferred', 'ticket', p_ticket, jsonb_build_object('to', p_to, 'qr_version', t.qr_version + 1));
end $$;

-- Reissue (lost phone, leaked screenshot): same ticket, same seat, new credentials. The holder or a manager.
create or replace function public.reissue_ticket(p_ticket uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare t public.tickets;
begin
  select * into t from public.tickets where id = p_ticket for update;
  if not found or not (t.owner = auth.uid() or public.can_manage_event(t.event_id) or public.is_admin()) then raise exception 'Ticket not found'; end if;
  if not public.ticket_still_admits(t) then raise exception 'This ticket no longer admits'; end if;
  if (select count(*) from public.audit_log where entity_id = t.id and action = 'ticket.reissued' and created_at > now() - interval '1 day') >= 3 then
    raise exception 'This ticket was reissued several times today. Contact VYBE support.';
  end if;
  update public.tickets set qr_version = qr_version + 1, code = upper(substr(md5(gen_random_uuid()::text || gen_random_uuid()::text), 1, 20)) where id = t.id;
  insert into public.audit_log (actor, action, entity_type, entity_id, detail) values (auth.uid(), 'ticket.reissued', 'ticket', t.id, jsonb_build_object('reason', left(coalesce(p_reason, ''), 300), 'qr_version', t.qr_version + 1));
end $$;

-- Revoke (fraud, organiser error): the ticket stops admitting at once. Money is handled by the refund flow, not here.
create or replace function public.revoke_ticket(p_ticket uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare t public.tickets;
begin
  if char_length(btrim(coalesce(p_reason, ''))) < 5 then raise exception 'Give a reason'; end if;
  select * into t from public.tickets where id = p_ticket for update;
  if not found or not (public.can_manage_event(t.event_id) or public.is_admin()) then raise exception 'forbidden' using errcode = '42501'; end if;
  if t.status <> 'valid' then raise exception 'Only an unused, valid ticket can be revoked'; end if;
  update public.tickets set status = 'void', revoked_reason = left(btrim(p_reason), 300), qr_version = qr_version + 1 where id = t.id;
  insert into public.audit_log (actor, action, entity_type, entity_id, detail) values (auth.uid(), 'ticket.revoked', 'ticket', t.id, jsonb_build_object('reason', left(btrim(p_reason), 300)));
  perform public.notify(t.owner, 'event_update', null, 'event', t.event_id, 'revoked:' || t.id);
end $$;

-- Seats: generate a block, and move a ticket to a seat (audited; a seat can never hold two live tickets).
create or replace function public.generate_seats(p_event uuid, p_zone uuid, p_section text, p_rows text[], p_seats_per_row integer) returns integer
language plpgsql security definer set search_path = '' as $$
declare r text; k integer; n integer := 0; base integer;
begin
  if not public.can_manage_event(p_event) then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_zone is not null and not exists (select 1 from public.event_zones z where z.id = p_zone and z.event_id = p_event) then raise exception 'That zone is not part of this event'; end if;
  if coalesce(p_seats_per_row, 0) not between 1 and 200 or coalesce(cardinality(p_rows), 0) not between 1 and 100 then raise exception 'Up to 100 rows of up to 200 seats'; end if;
  select coalesce(max(sort), 0) into base from public.event_seats where event_id = p_event;
  foreach r in array p_rows loop
    for k in 1..p_seats_per_row loop
      insert into public.event_seats (event_id, zone_id, section, row_label, seat_number, sort)
      values (p_event, p_zone, btrim(p_section), btrim(r), lpad(k::text, 3, '0'), base + n + 1)
      on conflict (event_id, section, row_label, seat_number) do nothing;
      if found then n := n + 1; end if;
    end loop;
  end loop;
  return n;
end $$;

create or replace function public.assign_seat(p_ticket uuid, p_seat uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare t public.tickets; s public.event_seats;
begin
  select * into t from public.tickets where id = p_ticket for update;
  if not found or not (public.can_manage_event(t.event_id) or public.is_admin()) then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_seat is not null then
    select * into s from public.event_seats where id = p_seat for update;
    if not found or s.event_id <> t.event_id then raise exception 'That seat is not part of this event'; end if;
    if s.status <> 'open' then raise exception 'That seat is blocked'; end if;
    if exists (select 1 from public.tickets x where x.seat_id = s.id and x.status in ('valid', 'used') and x.id <> t.id) then raise exception 'That seat is taken'; end if;
  end if;
  update public.tickets set seat_id = p_seat where id = t.id;
  insert into public.ticket_seat_changes (ticket_id, old_seat, new_seat, changed_by, reason) values (t.id, t.seat_id, p_seat, auth.uid(), left(coalesce(p_reason, ''), 300));
  perform public.notify(t.owner, 'event_update', null, 'event', t.event_id, 'seat:' || t.id || ':' || coalesce(p_seat::text, 'none'));
end $$;

-- Live numbers for the organiser (only from records: nothing estimated).
create or replace function public.admission_dashboard(p_event uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not (public.can_manage_event(p_event) or public.is_admin()) then raise exception 'forbidden' using errcode = '42501'; end if;
  return jsonb_build_object(
    'capacity', (select capacity from public.events where id = p_event),
    'issued', (select count(*) from public.tickets where event_id = p_event and status in ('valid', 'used')),
    'admitted', (select count(distinct ticket_id) from public.ticket_admissions where event_id = p_event and direction = 'in'),
    'inside_now', (select count(*) from public.tickets where event_id = p_event and inside),
    'unseated', (select count(*) from public.tickets t join public.ticket_types tt on tt.id = t.ticket_type_id
                  where t.event_id = p_event and tt.seating = 'reserved' and t.seat_id is null and t.status in ('valid', 'used')),
    'by_decision', coalesce((select jsonb_object_agg(k, n) from (select coalesce(decision, upper(result)) k, count(*) n from public.ticket_scans where event_id = p_event group by 1) x), '{}'::jsonb),
    'by_gate', coalesce((select jsonb_agg(jsonb_build_object('gate', coalesce(g.name, 'No gate'), 'admitted', x.a, 'denied', x.dn) order by g.name) from (
        select gate_id, count(*) filter (where decision = 'ACCEPTED' or result = 'ok') a, count(*) filter (where not (decision = 'ACCEPTED' or result in ('ok', 'exit'))) dn
          from public.ticket_scans where event_id = p_event group by gate_id) x left join public.event_gates g on g.id = x.gate_id), '[]'::jsonb),
    'by_type', coalesce((select jsonb_agg(jsonb_build_object('type', tt.name, 'issued', x.i, 'admitted', x.a) order by tt.sort) from (
        select t.ticket_type_id, count(*) filter (where t.status in ('valid', 'used')) i, count(*) filter (where t.entries > 0) a
          from public.tickets t where t.event_id = p_event group by 1) x join public.ticket_types tt on tt.id = x.ticket_type_id), '[]'::jsonb),
    'active_scanners', coalesce((select jsonb_agg(jsonb_build_object('id', ss.id, 'scanner', coalesce(nullif(p.display_name, ''), p.username), 'gate', g.name,
        'device', ss.device_label, 'last_seen_at', ss.last_seen_at) order by ss.last_seen_at desc)
        from public.scan_sessions ss join public.profiles p on p.id = ss.scanner left join public.event_gates g on g.id = ss.gate_id
       where ss.event_id = p_event and ss.ended_at is null and ss.revoked_at is null and ss.last_seen_at > now() - interval '12 hours'), '[]'::jsonb),
    'repeat_denials', coalesce((select jsonb_agg(jsonb_build_object('ref', t.ref, 'attempts', x.n)) from (
        select ticket_id, count(*) n from public.ticket_scans where event_id = p_event and ticket_id is not null and decision in ('ALREADY_USED', 'WRONG_GATE_OR_ZONE', 'REVOKED')
         and created_at > now() - interval '1 day' group by 1 having count(*) >= 3) x join public.tickets t on t.id = x.ticket_id), '[]'::jsonb));
end $$;

-- The holder's view of a ticket: what it grants and where to go. Nothing the holder may not know.
create or replace function public.my_ticket_details(p_ticket uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare t public.tickets; tt public.ticket_types; ev public.events; seat public.event_seats; w record;
begin
  select * into t from public.tickets where id = p_ticket and owner = auth.uid();
  if not found then return null; end if;
  select * into tt from public.ticket_types where id = t.ticket_type_id;
  select * into ev from public.events where id = t.event_id;
  if t.seat_id is not null then select * into seat from public.event_seats where id = t.seat_id; end if;
  select * into w from public.entry_window(ev, tt, null::public.event_sessions);
  return jsonb_build_object(
    'ref', t.ref, 'status', t.status, 'event_status', ev.status, 'entries', t.entries, 'entry_policy', tt.entry_policy, 'max_entries', tt.max_entries,
    'seat', case when seat.id is not null then public.seat_label(seat) when tt.seating = 'reserved' then 'Reserved seat — being assigned' else 'General Admission — No reserved seat' end,
    'zones', coalesce((select jsonb_agg(z.name order by z.name) from public.ticket_type_zones x join public.event_zones z on z.id = x.zone_id where x.ticket_type_id = tt.id), '[]'::jsonb),
    'gates', coalesce((select jsonb_agg(distinct g.name) from public.event_gates g where g.event_id = ev.id and g.status = 'open' and (
                 (not exists (select 1 from public.ticket_type_zones x where x.ticket_type_id = tt.id) and g.admits_unzoned)
              or exists (select 1 from public.gate_zones gz join public.ticket_type_zones x on x.zone_id = gz.zone_id where gz.gate_id = g.id and x.ticket_type_id = tt.id)
              or (exists (select 1 from public.ticket_type_zones x where x.ticket_type_id = tt.id) and not exists (select 1 from public.gate_zones gz where gz.gate_id = g.id)))), '[]'::jsonb),
    'sessions', coalesce((select jsonb_agg(jsonb_build_object('name', s.name, 'starts_at', s.starts_at, 'ends_at', s.ends_at,
                   'used', exists (select 1 from public.ticket_admissions a where a.ticket_id = t.id and a.session_id = s.id and a.direction = 'in')) order by s.starts_at)
                 from public.ticket_type_sessions x join public.event_sessions s on s.id = x.session_id where x.ticket_type_id = tt.id), '[]'::jsonb),
    'entry_opens_at', w.opens, 'entry_closes_at', w.closes, 'timezone', ev.timezone);
end $$;

-- Scheduling help (not admission): the caller's other tickets that overlap this event.
create or replace function public.my_ticket_conflicts(p_event uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(distinct jsonb_build_object('id', e2.id, 'title', e2.title, 'starts_at', e2.starts_at)), '[]'::jsonb)
    from public.events e1 join public.tickets t on t.owner = auth.uid() and t.status = 'valid'
    join public.events e2 on e2.id = t.event_id and e2.id <> e1.id and e2.status <> 'cancelled'
   where e1.id = p_event
     and tstzrange(e2.starts_at, coalesce(e2.ends_at, e2.starts_at + interval '4 hours')) && tstzrange(e1.starts_at, coalesce(e1.ends_at, e1.starts_at + interval '4 hours'));
$$;

-- ---------------------------------------------------------------- 14. RLS for the new organiser tables
do $$
declare tbl text;
begin
  foreach tbl in array array['event_sessions', 'event_zones', 'event_gates', 'event_seats'] loop
    execute format('alter table public.%I enable row level security', tbl);
    execute format('drop policy if exists %I on public.%I', tbl || '_read', tbl);
    execute format('create policy %I on public.%I for select to authenticated using (public.can_view_event_id(event_id))', tbl || '_read', tbl);
    execute format('drop policy if exists %I on public.%I', tbl || '_write', tbl);
    execute format('create policy %I on public.%I for all to authenticated using (public.can_manage_event(event_id)) with check (public.can_manage_event(event_id))', tbl || '_write', tbl);
    execute format('revoke all on public.%I from anon, authenticated', tbl);
    execute format('grant select, insert, update, delete on public.%I to authenticated', tbl);
  end loop;
end $$;
do $$
declare tbl text; parent text; col text;
begin
  foreach tbl in array array['gate_zones', 'ticket_type_zones', 'ticket_type_sessions'] loop
    parent := case tbl when 'gate_zones' then 'event_gates' else 'ticket_types' end;
    col := case tbl when 'gate_zones' then 'gate_id' else 'ticket_type_id' end;
    execute format('alter table public.%I enable row level security', tbl);
    execute format('drop policy if exists %I on public.%I', tbl || '_read', tbl);
    execute format('create policy %I on public.%I for select to authenticated using (exists (select 1 from public.%I p where p.id = %I and public.can_view_event_id(p.event_id)))', tbl || '_read', tbl, parent, col);
    execute format('drop policy if exists %I on public.%I', tbl || '_write', tbl);
    execute format('create policy %I on public.%I for all to authenticated using (exists (select 1 from public.%I p where p.id = %I and public.can_manage_event(p.event_id))) with check (exists (select 1 from public.%I p where p.id = %I and public.can_manage_event(p.event_id)))', tbl || '_write', tbl, parent, col, parent, col);
    execute format('revoke all on public.%I from anon, authenticated', tbl);
    execute format('grant select, insert, delete on public.%I to authenticated', tbl);
  end loop;
end $$;
-- A seat that a live ticket holds cannot be deleted (FK restrict) or blocked out from under the holder.
create or replace function public.trg_seat_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'blocked' and exists (select 1 from public.tickets t where t.seat_id = new.id and t.status in ('valid', 'used')) then
    raise exception 'Move the ticket on this seat first' using errcode = '23514';
  end if;
  if (new.event_id, new.section, new.row_label, new.seat_number) is distinct from (old.event_id, old.section, old.row_label, old.seat_number)
     and exists (select 1 from public.tickets t where t.seat_id = new.id and t.status in ('valid', 'used')) then
    raise exception 'A seat that is sold cannot be renamed; move the ticket instead' using errcode = '23514';
  end if;
  return new;
end $$;
drop trigger if exists seat_guard on public.event_seats;
create trigger seat_guard before update on public.event_seats for each row execute function public.trg_seat_guard();

-- Indexes for every new foreign key (advisor rule from migration 21).
create index if not exists event_schedule_changes_by_idx on public.event_schedule_changes (changed_by);
create index if not exists ticket_type_sessions_session_idx on public.ticket_type_sessions (session_id);
create index if not exists gate_zones_zone_idx on public.gate_zones (zone_id);
create index if not exists ticket_type_zones_zone_idx on public.ticket_type_zones (zone_id);
create index if not exists event_seats_zone_idx on public.event_seats (zone_id);
create index if not exists tickets_seat_idx on public.tickets (seat_id);
create index if not exists ticket_seat_changes_ticket_idx on public.ticket_seat_changes (ticket_id);
create index if not exists ticket_seat_changes_old_idx on public.ticket_seat_changes (old_seat);
create index if not exists ticket_seat_changes_new_idx on public.ticket_seat_changes (new_seat);
create index if not exists ticket_seat_changes_by_idx on public.ticket_seat_changes (changed_by);
create index if not exists ticket_admissions_session_idx on public.ticket_admissions (session_id);
create index if not exists ticket_admissions_gate_idx on public.ticket_admissions (gate_id);
create index if not exists ticket_admissions_scanner_idx on public.ticket_admissions (scanner);
create index if not exists event_staff_gate_idx on public.event_staff (gate_id);
create index if not exists scan_sessions_gate_idx on public.scan_sessions (gate_id);
create index if not exists scan_sessions_session_idx on public.scan_sessions (session_id);
create index if not exists scan_sessions_revoked_by_idx on public.scan_sessions (revoked_by);
create index if not exists ticket_scans_gate_idx on public.ticket_scans (gate_id);
create index if not exists ticket_scans_scan_session_idx on public.ticket_scans (scan_session_id);
create index if not exists ticket_scans_session_idx on public.ticket_scans (session_id);

-- ---------------------------------------------------------------- 15. grants
revoke execute on function public.start_scan_session(uuid, uuid, uuid, text), public.end_scan_session(uuid), public.revoke_scan_session(uuid),
  public.admission_scan(uuid, text, uuid, text), public.admission_override(uuid, uuid, uuid, text), public.reissue_ticket(uuid, text),
  public.revoke_ticket(uuid, text), public.generate_seats(uuid, uuid, text, text[], integer), public.assign_seat(uuid, uuid, text),
  public.admission_dashboard(uuid), public.my_ticket_details(uuid), public.my_ticket_conflicts(uuid), public.door_role(uuid) from public, anon;
grant execute on function public.start_scan_session(uuid, uuid, uuid, text), public.end_scan_session(uuid), public.revoke_scan_session(uuid),
  public.admission_scan(uuid, text, uuid, text), public.admission_override(uuid, uuid, uuid, text), public.reissue_ticket(uuid, text),
  public.revoke_ticket(uuid, text), public.generate_seats(uuid, uuid, text, text[], integer), public.assign_seat(uuid, uuid, text),
  public.admission_dashboard(uuid), public.my_ticket_details(uuid), public.my_ticket_conflicts(uuid), public.door_role(uuid) to authenticated;
revoke execute on function public.trg_append_only(), public.trg_event_window_shift(), public.trg_inventory_capacity(), public.trg_event_schedule_history(), public.trg_same_event_link(), public.trg_ticket_seat(), public.trg_staff_gate(),
  public.trg_seat_guard(), public.new_ticket_ref(), public.decision_message(text), public.seat_label(public.event_seats) from public, anon, authenticated;
