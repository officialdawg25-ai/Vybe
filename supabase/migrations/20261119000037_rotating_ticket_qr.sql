-- 37: Rotating, signed ticket QR (anti-screenshot, anti-tamper).
--
-- Until now the entry QR carried the ticket's static code. Redemption was already atomic, single-use and bound to the ticket's
-- own event (admit_ticket), but a screenshot of a valid ticket worked until the first person scanned it, so a copy could beat the
-- real holder to the door. This adds a short-lived signed token, the technique used by the large ticketing apps:
--
--   token  = VYBE2:<ticket id>:<30-second window>:<signature>
--   signature = nested SHA-256 of (server-only secret, ticket id, window), first 80 bits. Nobody without the secret can make or
--               alter one; changing the ticket id, the window or a single character invalidates it.
--   The door accepts the current window and one either side (about 30-90 seconds). A screenshot is therefore useless within
--   about a minute. The holder's app asks for the next few minutes of tokens while it is online and shows them as time passes,
--   so a patchy venue connection does not stop the QR changing. The ticket id is not a credential (the holder and API responses
--   already expose it); the static code is no longer shown or needed once rotation is required.
--
--   admit_ticket accepts both forms. Static codes keep working until an administrator turns on
--   platform_config.require_rotating_qr (admin_set_rotating_qr), which is meant to be done once the new app is live for everyone.
--   Everything else is unchanged: one atomic redemption under a row lock, event binding, payment/refund/cancel checks, logging,
--   throttling and the holder-only code.
--   Two new door answers: expired_qr (a genuine ticket whose token is too old: ask the holder to reopen it) and static_code
--   (rotation is required and a plain code was presented).
-- Additive. Rollback: restore admit_ticket / check_in_ticket from migration 28; drop my_ticket_qr, qr_sig, qr_secret,
-- admin_set_rotating_qr and the column; restore ticket_scans_result_check.

create table if not exists public.qr_secret (
  id boolean primary key default true check (id),
  secret text not null default (md5(gen_random_uuid()::text || gen_random_uuid()::text) || md5(gen_random_uuid()::text || gen_random_uuid()::text))
);
insert into public.qr_secret (id) values (true) on conflict do nothing;
alter table public.qr_secret enable row level security;       -- no policy and no grant: only the functions below can read it
revoke all on public.qr_secret from anon, authenticated;

alter table public.platform_config add column if not exists require_rotating_qr boolean not null default false;

alter table public.ticket_scans drop constraint if exists ticket_scans_result_check;
alter table public.ticket_scans add constraint ticket_scans_result_check
  check (result in ('ok', 'already_used', 'void', 'refunded', 'wrong_event', 'invalid', 'forbidden', 'event_cancelled', 'not_paid', 'rate_limited', 'expired_qr', 'static_code'));

-- Keyed hash (nested, so it is not open to length extension), truncated to 80 bits. Internal: nothing outside the database can call it.
create or replace function public.qr_sig(tid uuid, win bigint) returns text
language sql stable security definer set search_path = '' as $$
  select substr(encode(sha256(convert_to(
           (select secret from public.qr_secret) || ':' ||
           encode(sha256(convert_to((select secret from public.qr_secret) || ':' || tid::text || ':' || win::text, 'utf8')), 'hex'), 'utf8')), 'hex'), 1, 20);
$$;
revoke execute on function public.qr_sig(uuid, bigint) from public, anon, authenticated;

-- The holder's QR tokens: the current window and the next p_count - 1 (at most 24, i.e. 12 minutes), so the app can keep
-- changing the QR while the connection drops. Only the owner of a still-valid ticket gets anything.
create or replace function public.my_ticket_qr(p_ticket uuid, p_count integer default 1) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare t public.tickets; cfg public.platform_config; w bigint := floor(extract(epoch from now()) / 30)::bigint;
        n integer := greatest(1, least(coalesce(p_count, 1), 24)); out jsonb := '[]'::jsonb;
begin
  select * into t from public.tickets where id = p_ticket and owner = auth.uid() and status = 'valid';
  if not found then return null; end if;
  select * into cfg from public.platform_config where id;
  for i in 0..n - 1 loop
    out := out || jsonb_build_array(jsonb_build_object('w', w + i, 'token', 'VYBE2:' || t.id::text || ':' || (w + i)::text || ':' || public.qr_sig(t.id, w + i)));
  end loop;
  return jsonb_build_object('tokens', out, 'step_seconds', 30, 'static_ok', not cfg.require_rotating_qr, 'server_epoch', floor(extract(epoch from now()))::bigint);
end $$;

create or replace function public.admin_set_rotating_qr(p_required boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.platform_config set require_rotating_qr = coalesce(p_required, false) where id;
  insert into public.audit_log (actor, action, entity_type, entity_id, detail) values (auth.uid(), 'tickets.rotating_qr', 'platform', null, jsonb_build_object('required', p_required));
end $$;

-- Atomic, single-use redemption bound to one event, now also understanding signed tokens. Every attempt is recorded.
create or replace function public.admit_ticket(p_event uuid, p_code text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  t public.tickets; tt public.ticket_types; o public.orders; ev public.events; cfg public.platform_config; holder text; res text;
  raw text := btrim(coalesce(p_code, ''));
  c text := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  parts text[]; tid uuid; win bigint; cur bigint := floor(extract(epoch from now()) / 30)::bigint; token_old boolean := false;
begin
  if auth.uid() is null then raise exception 'Sign in' using errcode = '28000'; end if;
  select * into ev from public.events where id = p_event;
  if not found or not public.can_scan_event(p_event) then
    insert into public.ticket_scans (event_id, scanner, result) values (case when found then p_event end, auth.uid(), 'forbidden');
    return jsonb_build_object('result', 'forbidden');
  end if;
  if (select count(*) from public.ticket_scans where scanner = auth.uid() and result in ('invalid', 'wrong_event') and created_at > now() - interval '5 minutes') >= 40 then
    insert into public.ticket_scans (event_id, scanner, result) values (p_event, auth.uid(), 'rate_limited');
    return jsonb_build_object('result', 'rate_limited');
  end if;
  select * into cfg from public.platform_config where id;

  if upper(raw) like 'VYBE2:%' then
    parts := string_to_array(raw, ':');
    if cardinality(parts) <> 4 or lower(parts[2]) !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' or parts[3] !~ '^[0-9]{1,12}$' then
      insert into public.ticket_scans (event_id, scanner, result) values (p_event, auth.uid(), 'invalid');
      return jsonb_build_object('result', 'invalid');
    end if;
    tid := lower(parts[2])::uuid; win := parts[3]::bigint;
    if public.qr_sig(tid, win) <> lower(parts[4]) then                      -- altered, or never issued by VYBE
      insert into public.ticket_scans (event_id, scanner, result) values (p_event, auth.uid(), 'invalid');
      return jsonb_build_object('result', 'invalid');
    end if;
    token_old := abs(cur - win) > 1;
    select * into t from public.tickets where id = tid for update;
  else
    if cfg.require_rotating_qr then                                         -- a static code or a screenshot of one
      insert into public.ticket_scans (event_id, scanner, result) values (p_event, auth.uid(), 'static_code');
      return jsonb_build_object('result', 'static_code');
    end if;
    if c like 'VYBE1%' then c := substr(c, 6); end if;
    select * into t from public.tickets where code = c for update;
  end if;

  if not found then
    insert into public.ticket_scans (event_id, scanner, result) values (p_event, auth.uid(), 'invalid');
    return jsonb_build_object('result', 'invalid');
  end if;
  if t.event_id <> p_event then
    insert into public.ticket_scans (event_id, ticket_id, scanner, result) values (p_event, t.id, auth.uid(), 'wrong_event');
    return jsonb_build_object('result', 'wrong_event');
  end if;
  select * into tt from public.ticket_types where id = t.ticket_type_id;
  select * into o from public.orders where id = t.order_id;
  select coalesce(nullif(display_name, ''), username) into holder from public.profiles where id = t.owner;
  res := case when ev.status = 'cancelled' then 'event_cancelled'
              when t.status = 'used' then 'already_used'
              when t.status = 'refunded' then 'refunded'
              when t.status = 'void' then 'void'
              when o.status not in ('paid', 'partially_refunded') then 'not_paid'
              when token_old then 'expired_qr'
              else 'ok' end;
  if res = 'ok' then update public.tickets set status = 'used', used_at = now(), used_by = auth.uid() where id = t.id; end if;
  insert into public.ticket_scans (event_id, ticket_id, scanner, result) values (p_event, t.id, auth.uid(), res);
  return jsonb_build_object('result', res, 'ticket_type', tt.name, 'holder', holder, 'used_at', case when res = 'already_used' then t.used_at end);
end $$;

-- The code-only check used by older screens: find the ticket's event (from a token or a code) and apply the same rules.
create or replace function public.check_in_ticket(p_code text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare eid uuid; raw text := btrim(coalesce(p_code, '')); c text := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g')); r jsonb; parts text[];
begin
  if upper(raw) like 'VYBE2:%' then
    parts := string_to_array(raw, ':');
    if cardinality(parts) = 4 and lower(parts[2]) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      select event_id into eid from public.tickets where id = lower(parts[2])::uuid;
    end if;
  else
    if c like 'VYBE1%' then c := substr(c, 6); end if;
    select event_id into eid from public.tickets where code = c;
  end if;
  if eid is null then
    insert into public.ticket_scans (scanner, result) values (auth.uid(), 'invalid');
    return jsonb_build_object('result', 'invalid');
  end if;
  r := public.admit_ticket(eid, raw);
  return case when r->>'result' = 'already_used' then r || jsonb_build_object('result', 'used') else r end;
end $$;

revoke execute on function public.my_ticket_qr(uuid, integer), public.admin_set_rotating_qr(boolean) from public, anon;
grant execute on function public.my_ticket_qr(uuid, integer), public.admin_set_rotating_qr(boolean) to authenticated;
