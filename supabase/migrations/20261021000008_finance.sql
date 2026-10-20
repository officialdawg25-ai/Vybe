-- Finance: VAT, receipts/tax invoices, refunds, chargebacks, an append-only ledger, organizer payout accounts and payouts.
-- Additive and re-runnable. Principles:
--   * Money only moves through these functions; every movement is an immutable ledger row.
--   * Clients never write money tables. Gateway calls happen in edge functions (service role); humans approve in the portals.
--   * Organizer bank details are stored ENCRYPTED by an edge function; the API never exposes the ciphertext.

alter table public.platform_config add column if not exists vat_registered boolean not null default false;
alter table public.platform_config add column if not exists vat_rate_bps integer not null default 1500 check (vat_rate_bps between 0 and 5000);
alter table public.platform_config add column if not exists vat_number text check (vat_number is null or char_length(vat_number) <= 30);
alter table public.platform_config add column if not exists legal_name text not null default 'VYBE' check (char_length(legal_name) <= 120);
alter table public.platform_config add column if not exists settlement_hold_days integer not null default 3 check (settlement_hold_days between 0 and 30);
alter table public.platform_config add column if not exists payout_min_cents integer not null default 10000 check (payout_min_cents >= 0);
alter table public.platform_config add column if not exists buyer_refund_hours integer not null default 48 check (buyer_refund_hours between 0 and 720);

alter table public.orders add column if not exists fee_vat_cents bigint not null default 0 check (fee_vat_cents >= 0);
alter table public.orders add column if not exists refunded_cents bigint not null default 0 check (refunded_cents >= 0);
alter table public.orders add column if not exists payment_method text;
alter table public.orders add column if not exists ip_hash text;
alter table public.orders drop constraint if exists orders_status_check;
alter table public.orders add constraint orders_status_check
  check (status in ('pending','paid','failed','cancelled','expired','refunded','partially_refunded','disputed'));
alter table public.tickets drop constraint if exists tickets_status_check;
alter table public.tickets add constraint tickets_status_check check (status in ('valid','used','void','refunded'));
alter table public.tickets add column if not exists void_reason text;

-- ------------------------------------------------------------------ who gets paid, who may see the money
create or replace function public.event_payee(eid uuid, out org uuid, out usr uuid)
language sql stable security definer set search_path = '' as $$
  select e.organization_id, case when e.organization_id is null then e.host end from public.events e where e.id = eid;
$$;
create or replace function public.can_view_finance(p_org uuid, p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.is_admin() or (p_user is not null and p_user = auth.uid()) or (p_org is not null and public.org_role(p_org) in ('owner','admin'));
$$;
revoke execute on function public.event_payee(uuid), public.can_view_finance(uuid, uuid) from public, anon;
grant execute on function public.event_payee(uuid), public.can_view_finance(uuid, uuid) to authenticated;

-- ------------------------------------------------------------------ refunds, disputes, payouts (tables first; the ledger refers to them)
create table if not exists public.refunds (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete restrict,
  requested_by uuid not null references public.profiles(id) on delete restrict,
  kind text not null check (kind in ('buyer_request','organizer','event_cancelled','admin')),
  status text not null default 'requested' check (status in ('requested','approved','processing','succeeded','failed','rejected','manual_required')),
  ticket_ids uuid[] not null default '{}',
  ticket_amount_cents bigint not null check (ticket_amount_cents >= 0),
  fee_amount_cents bigint not null default 0 check (fee_amount_cents >= 0),
  reason text not null default '' check (char_length(reason) <= 500),
  provider text,
  provider_ref text,
  error text,
  decided_by uuid references public.profiles(id) on delete set null,
  decided_at timestamptz,
  processed_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists refunds_one_active on public.refunds (order_id) where status in ('requested','approved','processing','manual_required');
create index if not exists refunds_status_idx on public.refunds (status, created_at);

create table if not exists public.disputes (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete restrict,
  status text not null default 'open' check (status in ('open','won','lost')),
  amount_cents bigint not null check (amount_cents > 0),
  reason text not null default '' check (char_length(reason) <= 500),
  evidence text not null default '' check (char_length(evidence) <= 4000),
  opened_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create unique index if not exists disputes_one_open on public.disputes (order_id) where status = 'open';

create table if not exists public.buyer_flags (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  reason text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.payout_accounts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid unique references public.organizations(id) on delete cascade,
  user_id uuid unique references public.profiles(id) on delete cascade,
  holder text not null check (char_length(holder) between 2 and 120),
  bank text not null check (char_length(bank) between 2 and 80),
  account_last4 text not null check (account_last4 ~ '^[0-9]{2,4}$'),
  details_enc text not null,
  status text not null default 'pending' check (status in ('pending','verified','rejected')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((organization_id is not null) <> (user_id is not null))
);

create table if not exists public.payouts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete restrict,
  user_id uuid references public.profiles(id) on delete restrict,
  amount_cents bigint not null check (amount_cents > 0),
  status text not null default 'requested' check (status in ('requested','approved','paid','rejected','failed')),
  requested_by uuid not null references public.profiles(id) on delete restrict,
  decided_by uuid references public.profiles(id) on delete set null,
  bank_reference text,
  note text not null default '' check (char_length(note) <= 500),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  paid_at timestamptz,
  check ((organization_id is not null) <> (user_id is not null))
);
create index if not exists payouts_status_idx on public.payouts (status, created_at);

create table if not exists public.ledger_entries (
  id bigint generated always as identity primary key,
  event_id uuid references public.events(id) on delete restrict,
  organization_id uuid references public.organizations(id) on delete restrict,
  payee_user uuid references public.profiles(id) on delete restrict,
  order_id uuid references public.orders(id) on delete restrict,
  refund_id uuid references public.refunds(id) on delete restrict,
  payout_id uuid references public.payouts(id) on delete restrict,
  dispute_id uuid references public.disputes(id) on delete restrict,
  kind text not null check (kind in ('sale','refund','chargeback','payout','adjustment')),
  amount_cents bigint not null,                    -- + increases what the payee is owed, − decreases it
  note text not null default '',
  created_at timestamptz not null default now(),
  check ((organization_id is not null) <> (payee_user is not null))
);
create index if not exists ledger_org_idx on public.ledger_entries (organization_id, created_at);
create index if not exists ledger_user_idx on public.ledger_entries (payee_user, created_at);
create index if not exists ledger_event_idx on public.ledger_entries (event_id);
create or replace function public.trg_ledger_immutable() returns trigger language plpgsql set search_path = '' as $$
begin raise exception 'ledger entries are append-only'; end $$;
drop trigger if exists ledger_immutable on public.ledger_entries;
create trigger ledger_immutable before update or delete on public.ledger_entries for each row execute function public.trg_ledger_immutable();

create table if not exists public.invoices (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references public.orders(id) on delete restrict,
  buyer uuid not null references public.profiles(id) on delete restrict,
  number text not null unique,
  kind text not null check (kind in ('receipt','tax_invoice')),
  issued_at timestamptz not null default now(),
  legal_name text not null,
  vat_number text,
  buyer_name text not null default '',
  lines jsonb not null,
  subtotal_cents bigint not null,
  fee_cents bigint not null,
  fee_vat_cents bigint not null default 0,
  total_cents bigint not null
);
create sequence if not exists public.invoice_seq;

alter table public.refunds enable row level security;
alter table public.disputes enable row level security;
alter table public.buyer_flags enable row level security;
alter table public.payout_accounts enable row level security;
alter table public.payouts enable row level security;
alter table public.ledger_entries enable row level security;
alter table public.invoices enable row level security;

drop policy if exists refunds_select on public.refunds;
create policy refunds_select on public.refunds for select to authenticated
  using (requested_by = auth.uid() or public.is_admin()
         or exists (select 1 from public.orders o where o.id = order_id and (o.buyer = auth.uid() or public.can_manage_event(o.event_id))));
drop policy if exists disputes_select on public.disputes;
create policy disputes_select on public.disputes for select to authenticated using (public.is_admin());
drop policy if exists flags_select on public.buyer_flags;
create policy flags_select on public.buyer_flags for select to authenticated using (public.is_admin());
drop policy if exists pa_select on public.payout_accounts;
create policy pa_select on public.payout_accounts for select to authenticated using (public.can_view_finance(organization_id, user_id));
drop policy if exists payouts_select on public.payouts;
create policy payouts_select on public.payouts for select to authenticated using (public.can_view_finance(organization_id, user_id));
drop policy if exists ledger_select on public.ledger_entries;
create policy ledger_select on public.ledger_entries for select to authenticated using (public.can_view_finance(organization_id, payee_user));
drop policy if exists invoices_select on public.invoices;
create policy invoices_select on public.invoices for select to authenticated using (buyer = auth.uid() or public.is_admin());
drop policy if exists orders_admin_select on public.orders;
create policy orders_admin_select on public.orders for select to authenticated using (public.is_admin());

revoke all on public.refunds, public.disputes, public.buyer_flags, public.payout_accounts, public.payouts, public.ledger_entries, public.invoices from anon, authenticated;
grant select on public.refunds, public.disputes, public.buyer_flags, public.payouts, public.ledger_entries, public.invoices to authenticated;
-- The encrypted bank details are never selectable through the API.
grant select (id, organization_id, user_id, holder, bank, account_last4, status, created_at, updated_at) on public.payout_accounts to authenticated;

-- Stock held: paid and partially refunded orders (refunded / disputed ones release it), plus unexpired pending holds.
create or replace function public.ticket_units_taken(tt uuid) returns bigint
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(oi.qty), 0) from public.order_items oi join public.orders o on o.id = oi.order_id
  where oi.ticket_type_id = tt and (o.status in ('paid','partially_refunded') or (o.status = 'pending' and o.expires_at > now()));
$$;

-- ------------------------------------------------------------------ orders: VAT on the service fee, risk gate, receipts, ledger
create or replace function public.create_order(p_event uuid, p_items jsonb, p_provider text, p_idem text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid(); ev public.events; cfg public.platform_config; ord public.orders;
  it jsonb; tt public.ticket_types; q integer; subtotal bigint := 0; fee bigint := 0; vat bigint := 0; total_units integer := 0; mine integer;
begin
  if uid is null then raise exception 'Sign in to buy tickets' using errcode = '28000'; end if;
  if exists (select 1 from public.buyer_flags where user_id = uid) then raise exception 'Purchases are disabled for this account. Please contact support.'; end if;
  if p_provider is null or p_provider not in ('payfast','ozow') then raise exception 'Choose PayFast or Ozow'; end if;
  if p_idem is null or char_length(p_idem) < 8 then raise exception 'Missing idempotency key'; end if;
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) not between 1 and 10 then raise exception 'Choose at least one ticket'; end if;

  select * into ord from public.orders where buyer = uid and idempotency_key = p_idem;
  if found then return jsonb_build_object('id', ord.id, 'status', ord.status, 'total_cents', ord.total_cents, 'fee_cents', ord.fee_cents, 'subtotal_cents', ord.subtotal_cents, 'expires_at', ord.expires_at); end if;

  select * into cfg from public.platform_config where id;
  select * into ev from public.events e where e.id = p_event;
  if not found or ev.status <> 'active' or not public.can_view_event(ev) then raise exception 'This event is not available'; end if;
  if coalesce(ev.ends_at, ev.starts_at + interval '6 hours') < now() then raise exception 'This event has ended'; end if;

  if (select count(*) from public.orders where buyer = uid and created_at > now() - interval '10 minutes') >= 6 then raise exception 'Too many attempts. Please wait a few minutes.'; end if;
  if (select count(*) from public.orders where buyer = uid and created_at > now() - interval '24 hours') >= 30 then raise exception 'Daily purchase limit reached.'; end if;
  if (select count(*) from public.orders where buyer = uid and status = 'pending' and expires_at > now()) >= 3 then raise exception 'Finish or cancel your pending orders first.'; end if;

  for it in select * from jsonb_array_elements(p_items) loop
    q := (it->>'qty')::integer;
    select * into tt from public.ticket_types where id = (it->>'ticket_type_id')::uuid and event_id = p_event for update;
    if not found then raise exception 'Unknown ticket type'; end if;
    if tt.status <> 'active' then raise exception '% is not on sale', tt.name; end if;
    if tt.sales_start is not null and tt.sales_start > now() then raise exception '% is not on sale yet', tt.name; end if;
    if tt.sales_end is not null and tt.sales_end < now() then raise exception 'Sales for % have closed', tt.name; end if;
    if q is null or q < 1 or q > tt.max_per_order then raise exception 'You can buy 1 to % of %', tt.max_per_order, tt.name; end if;
    if public.ticket_units_taken(tt.id) + q > tt.quantity_total then raise exception '% is sold out', tt.name; end if;
    subtotal := subtotal + tt.price_cents::bigint * q;
    total_units := total_units + q * tt.group_size;
  end loop;
  if total_units > cfg.max_tickets_per_order then raise exception 'You can buy up to % tickets per order', cfg.max_tickets_per_order; end if;
  select count(*) into mine from public.tickets where owner = uid and event_id = p_event and status in ('valid','used');
  if mine + total_units > 20 then raise exception 'Ticket limit per person reached for this event'; end if;

  if subtotal > 0 then
    fee := ceil(subtotal * cfg.fee_bps / 10000.0)::bigint + cfg.fee_fixed_cents;                  -- VAT-inclusive when VAT-registered
    if cfg.vat_registered then vat := round(fee * cfg.vat_rate_bps / (10000.0 + cfg.vat_rate_bps))::bigint; end if;
  end if;
  if subtotal + fee > 0 and subtotal + fee < 500 then raise exception 'The minimum card/EFT payment is R5.00'; end if;

  insert into public.orders (buyer, event_id, provider, subtotal_cents, fee_cents, fee_vat_cents, total_cents, idempotency_key, expires_at)
  values (uid, p_event, case when subtotal = 0 then 'free' else p_provider end, subtotal, fee, vat, subtotal + fee, p_idem, now() + make_interval(mins => cfg.hold_minutes))
  returning * into ord;
  for it in select * from jsonb_array_elements(p_items) loop
    insert into public.order_items (order_id, ticket_type_id, qty, unit_price_cents)
    select ord.id, t.id, (it->>'qty')::integer, t.price_cents from public.ticket_types t where t.id = (it->>'ticket_type_id')::uuid;
  end loop;

  if ord.total_cents = 0 then perform public.issue_tickets(ord.id, 'free', null); select * into ord from public.orders where id = ord.id; end if;
  return jsonb_build_object('id', ord.id, 'status', ord.status, 'total_cents', ord.total_cents, 'fee_cents', ord.fee_cents, 'subtotal_cents', ord.subtotal_cents, 'expires_at', ord.expires_at);
end $$;

create or replace function public.issue_tickets(p_order uuid, p_provider text, p_ref text, p_method text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.orders; r record; n integer; k integer; cfg public.platform_config; pay record; lines jsonb; bname text;
begin
  select * into o from public.orders where id = p_order for update;
  if not found then raise exception 'order not found'; end if;
  if o.status in ('paid','partially_refunded','refunded','disputed') then return; end if;
  if o.status not in ('pending','expired') then raise exception 'order is %', o.status; end if;
  if o.status = 'expired' then
    for r in select oi.ticket_type_id, oi.qty, tt.quantity_total from public.order_items oi join public.ticket_types tt on tt.id = oi.ticket_type_id where oi.order_id = o.id loop
      if public.ticket_units_taken(r.ticket_type_id) + r.qty > r.quantity_total then
        update public.orders set status = 'failed', provider = p_provider, provider_ref = p_ref where id = o.id;
        insert into public.audit_log (actor, action, entity_type, entity_id, detail) values (null, 'order.paid_after_expiry_soldout', 'order', o.id, jsonb_build_object('provider', p_provider, 'ref', p_ref));
        return;
      end if;
    end loop;
  end if;
  for r in select oi.qty, oi.ticket_type_id, tt.group_size from public.order_items oi join public.ticket_types tt on tt.id = oi.ticket_type_id where oi.order_id = o.id loop
    n := r.qty * r.group_size;
    for k in 1..n loop
      insert into public.tickets (order_id, event_id, ticket_type_id, owner, code)
      values (o.id, o.event_id, r.ticket_type_id, o.buyer, upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 20)));
    end loop;
  end loop;
  update public.orders set status = 'paid', provider = p_provider, provider_ref = coalesce(p_ref, provider_ref), payment_method = coalesce(p_method, payment_method), paid_at = now() where id = o.id;

  -- organizer's share of the sale goes on the ledger
  select * into pay from public.event_payee(o.event_id);
  if o.subtotal_cents > 0 then
    insert into public.ledger_entries (event_id, organization_id, payee_user, order_id, kind, amount_cents, note)
    values (o.event_id, pay.org, pay.usr, o.id, 'sale', o.subtotal_cents, 'Ticket sales');
  end if;

  -- receipt / tax invoice for the buyer
  select * into cfg from public.platform_config where id;
  select coalesce(nullif(display_name, ''), username) into bname from public.profiles where id = o.buyer;
  select coalesce(jsonb_agg(jsonb_build_object('name', tt.name, 'qty', oi.qty, 'unit_price_cents', oi.unit_price_cents, 'line_total_cents', oi.qty * oi.unit_price_cents, 'tickets', oi.qty * tt.group_size)), '[]'::jsonb)
    into lines from public.order_items oi join public.ticket_types tt on tt.id = oi.ticket_type_id where oi.order_id = o.id;
  insert into public.invoices (order_id, buyer, number, kind, legal_name, vat_number, buyer_name, lines, subtotal_cents, fee_cents, fee_vat_cents, total_cents)
  values (o.id, o.buyer, 'VYB-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('public.invoice_seq')::text, 6, '0'),
          case when cfg.vat_registered and cfg.vat_number is not null then 'tax_invoice' else 'receipt' end,
          cfg.legal_name, case when cfg.vat_registered then cfg.vat_number end, coalesce(bname, ''), lines, o.subtotal_cents, o.fee_cents, o.fee_vat_cents, o.total_cents)
  on conflict (order_id) do nothing;

  begin
    insert into public.event_rsvps (event_id, user_id, status) values (o.event_id, o.buyer, 'going')
    on conflict (event_id, user_id) do update set status = 'going';
  exception when others then null;
  end;
end $$;

create or replace function public.fulfill_order(p_order uuid, p_provider text, p_ref text, p_amount_cents bigint, p_method text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.orders;
begin
  select * into o from public.orders where id = p_order;
  if not found then raise exception 'order not found'; end if;
  if o.total_cents <> p_amount_cents then
    insert into public.audit_log (actor, action, entity_type, entity_id, detail)
    values (null, 'order.amount_mismatch', 'order', o.id, jsonb_build_object('expected', o.total_cents, 'got', p_amount_cents, 'provider', p_provider, 'ref', p_ref));
    raise exception 'amount mismatch';
  end if;
  if o.provider is distinct from p_provider and o.provider <> 'free' then raise exception 'provider mismatch'; end if;
  perform public.issue_tickets(p_order, p_provider, p_ref, p_method);
end $$;

-- ------------------------------------------------------------------ refunds
-- A buyer asks for a refund. Inside the self-service window (default: until 48 h before the event) it is approved at once;
-- later it waits for the organizer or an admin. Used tickets can never be refunded.
create or replace function public.request_refund(p_order uuid, p_reason text, p_tickets uuid[] default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare o public.orders; ev public.events; cfg public.platform_config; ids uuid[]; amt bigint := 0; r public.refunds; st text; bad integer; is_full boolean;
begin
  select * into o from public.orders where id = p_order;
  if not found or o.buyer <> auth.uid() then raise exception 'Order not found'; end if;
  if o.status not in ('paid','partially_refunded') then raise exception 'This order cannot be refunded'; end if;
  select * into ev from public.events where id = o.event_id;
  select * into cfg from public.platform_config where id;
  if p_tickets is null or cardinality(p_tickets) = 0 then
    select array_agg(id) into ids from public.tickets where order_id = o.id and status = 'valid';
  else
    ids := p_tickets;
    select count(*) into bad from unnest(ids) x where not exists (select 1 from public.tickets t where t.id = x and t.order_id = o.id and t.status = 'valid');
    if bad > 0 then raise exception 'Some tickets cannot be refunded (already used, refunded or not yours)'; end if;
  end if;
  if ids is null or cardinality(ids) = 0 then raise exception 'There is nothing left to refund on this order'; end if;
  select coalesce(sum(case when tt.group_size > 1 then tt.price_cents / tt.group_size else tt.price_cents end), 0) into amt
    from public.tickets t join public.ticket_types tt on tt.id = t.ticket_type_id where t.id = any (ids);
  amt := least(amt, o.subtotal_cents - least(o.refunded_cents, o.subtotal_cents));
  if amt <= 0 and o.subtotal_cents > 0 then raise exception 'There is nothing left to refund on this order'; end if;
  is_full := not exists (select 1 from public.tickets t where t.order_id = o.id and t.status = 'valid' and t.id <> all (ids)) and o.refunded_cents = 0 and not exists (select 1 from public.tickets t where t.order_id = o.id and t.status <> 'valid');
  st := case when now() <= ev.starts_at - make_interval(hours => cfg.buyer_refund_hours) then 'approved' else 'requested' end;
  insert into public.refunds (order_id, requested_by, kind, status, ticket_ids, ticket_amount_cents, fee_amount_cents, reason, decided_at)
  values (o.id, auth.uid(), 'buyer_request', st, ids, amt, 0, left(coalesce(p_reason, ''), 500), case when st = 'approved' then now() end)
  returning * into r;
  return jsonb_build_object('id', r.id, 'status', r.status, 'ticket_amount_cents', r.ticket_amount_cents, 'full', is_full);
end $$;

-- Organizer (host / org editors+) or admin approves or rejects.
create or replace function public.decide_refund(p_refund uuid, p_approve boolean, p_note text default '') returns void
language plpgsql security definer set search_path = '' as $$
declare r public.refunds; o public.orders;
begin
  select * into r from public.refunds where id = p_refund for update;
  if not found then raise exception 'Refund not found'; end if;
  select * into o from public.orders where id = r.order_id;
  if not (public.is_admin() or public.can_manage_event(o.event_id)) then raise exception 'forbidden' using errcode = '42501'; end if;
  if r.status <> 'requested' then raise exception 'This refund is already %', r.status; end if;
  update public.refunds set status = case when p_approve then 'approved' else 'rejected' end, decided_by = auth.uid(), decided_at = now(),
         reason = case when p_note <> '' then left(reason || E'\n' || p_note, 500) else reason end where id = p_refund;
end $$;

-- Host cancels an event with sales: every paid order is refunded in full, service fee included.
create or replace function public.cancel_event_with_refunds(p_event uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare o record; n integer := 0;
begin
  if not (public.is_admin() or public.can_manage_event(p_event)) then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.events set status = 'cancelled' where id = p_event;
  update public.ticket_types set status = 'paused' where event_id = p_event;
  update public.live_streams set status = 'cancelled' where event_id = p_event and status = 'scheduled';
  for o in select * from public.orders where event_id = p_event and status in ('paid','partially_refunded') loop
    continue when exists (select 1 from public.refunds where order_id = o.id and status in ('requested','approved','processing','manual_required'));
    insert into public.refunds (order_id, requested_by, kind, status, ticket_ids, ticket_amount_cents, fee_amount_cents, reason, decided_by, decided_at)
    select o.id, auth.uid(), 'event_cancelled', 'approved', coalesce(array_agg(t.id), '{}'), greatest(0, o.subtotal_cents - o.refunded_cents), case when o.refunded_cents = 0 then o.fee_cents else 0 end,
           'Event cancelled by the organizer', auth.uid(), now()
      from public.tickets t where t.order_id = o.id and t.status = 'valid';
    n := n + 1;
  end loop;
  return n;
end $$;

-- Edge function claims an approved refund (atomic, so two workers never refund the same order twice).
create or replace function public.refund_claim(p_refund uuid) returns public.refunds
language plpgsql security definer set search_path = '' as $$
declare r public.refunds;
begin
  update public.refunds set status = 'processing' where id = p_refund and status = 'approved' returning * into r;
  return r;
end $$;

-- Records the outcome of a refund. Success voids the tickets, updates the order and writes the ledger.
create or replace function public.refund_finish(p_refund uuid, p_status text, p_provider text, p_ref text, p_error text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.refunds; o public.orders; pay record; total bigint;
begin
  if p_status not in ('succeeded','failed','manual_required') then raise exception 'bad status'; end if;
  select * into r from public.refunds where id = p_refund for update;
  if not found then raise exception 'Refund not found'; end if;
  if r.status not in ('processing','manual_required') then raise exception 'Refund is %', r.status; end if;
  if p_status <> 'succeeded' then
    update public.refunds set status = p_status, provider = p_provider, error = left(p_error, 500) where id = p_refund;
    return;
  end if;
  select * into o from public.orders where id = r.order_id for update;
  total := r.ticket_amount_cents + r.fee_amount_cents;
  update public.refunds set status = 'succeeded', provider = p_provider, provider_ref = p_ref, error = null, processed_at = now() where id = p_refund;
  update public.tickets set status = 'refunded' where id = any (r.ticket_ids) and status = 'valid';
  update public.orders set refunded_cents = refunded_cents + total,
         status = case when refunded_cents + total >= total_cents or not exists (select 1 from public.tickets t where t.order_id = orders.id and t.status in ('valid','used')) then 'refunded' else 'partially_refunded' end
   where id = o.id;
  select * into pay from public.event_payee(o.event_id);
  if r.ticket_amount_cents > 0 then
    insert into public.ledger_entries (event_id, organization_id, payee_user, order_id, refund_id, kind, amount_cents, note)
    values (o.event_id, pay.org, pay.usr, o.id, r.id, 'refund', -r.ticket_amount_cents, 'Refund to buyer');
  end if;
  insert into public.audit_log (actor, action, entity_type, entity_id, detail) values (auth.uid(), 'refund.succeeded', 'refund', r.id, jsonb_build_object('order', o.id, 'total_cents', total, 'provider', p_provider));
end $$;

-- Admin completes a refund that had to be paid by hand (provider dashboard / bank).
create or replace function public.admin_complete_refund(p_refund uuid, p_reference text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  perform public.refund_finish(p_refund, 'succeeded', 'manual', left(p_reference, 120));
end $$;

-- ------------------------------------------------------------------ chargebacks / disputes (admin-recorded; neither gateway pushes them to us)
create or replace function public.open_dispute(p_order uuid, p_amount bigint, p_reason text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare o public.orders; new_id uuid;
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into o from public.orders where id = p_order for update;
  if not found or o.status not in ('paid','partially_refunded') then raise exception 'Only paid orders can be disputed'; end if;
  if p_amount is null or p_amount <= 0 or p_amount > o.total_cents then raise exception 'Invalid dispute amount'; end if;
  insert into public.disputes (order_id, amount_cents, reason, opened_by) values (o.id, p_amount, left(coalesce(p_reason, ''), 500), auth.uid()) returning disputes.id into new_id;
  update public.orders set status = 'disputed' where id = o.id;
  update public.tickets set status = 'void', void_reason = 'dispute' where order_id = o.id and status = 'valid';   -- no entry while a chargeback is open
  return new_id;
end $$;

create or replace function public.resolve_dispute(p_dispute uuid, p_outcome text, p_evidence text default '') returns void
language plpgsql security definer set search_path = '' as $$
declare d public.disputes; o public.orders; pay record;
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_outcome not in ('won','lost') then raise exception 'Outcome must be won or lost'; end if;
  select * into d from public.disputes where id = p_dispute for update;
  if not found or d.status <> 'open' then raise exception 'Dispute is not open'; end if;
  select * into o from public.orders where id = d.order_id for update;
  update public.disputes set status = p_outcome, evidence = left(coalesce(p_evidence, evidence), 4000), resolved_at = now() where id = d.id;
  if p_outcome = 'won' then
    update public.tickets set status = 'valid', void_reason = null where order_id = o.id and void_reason = 'dispute';
    update public.orders set status = case when refunded_cents > 0 then 'partially_refunded' else 'paid' end where id = o.id;
  else
    select * into pay from public.event_payee(o.event_id);
    insert into public.ledger_entries (event_id, organization_id, payee_user, order_id, dispute_id, kind, amount_cents, note)
    values (o.event_id, pay.org, pay.usr, o.id, d.id, 'chargeback', -least(d.amount_cents, o.subtotal_cents), 'Chargeback lost');
    update public.orders set status = 'refunded', refunded_cents = o.total_cents where id = o.id;
    update public.tickets set status = 'void', void_reason = 'chargeback' where order_id = o.id and status <> 'used';
    insert into public.buyer_flags (user_id, reason) values (o.buyer, 'Lost chargeback on order ' || o.id) on conflict do nothing;
  end if;
  insert into public.audit_log (actor, action, entity_type, entity_id, detail) values (auth.uid(), 'dispute.' || p_outcome, 'dispute', d.id, jsonb_build_object('order', o.id));
end $$;

-- ------------------------------------------------------------------ payouts
create or replace function public.payout_balance(p_org uuid default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare cfg public.platform_config; u uuid := case when p_org is null then auth.uid() end;
        gross bigint; settled bigint; reductions bigint; paid bigint; pending bigint; disputed bigint;
begin
  if not public.can_view_finance(p_org, u) then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into cfg from public.platform_config where id;
  select coalesce(sum(l.amount_cents), 0) into gross from public.ledger_entries l where l.kind = 'sale' and l.organization_id is not distinct from p_org and l.payee_user is not distinct from u;
  select coalesce(sum(l.amount_cents), 0) into settled from public.ledger_entries l join public.events e on e.id = l.event_id
   where l.kind = 'sale' and l.organization_id is not distinct from p_org and l.payee_user is not distinct from u
     and coalesce(e.ends_at, e.starts_at + interval '6 hours') + make_interval(days => cfg.settlement_hold_days) <= now();
  select coalesce(sum(l.amount_cents), 0) into reductions from public.ledger_entries l where l.kind in ('refund','chargeback','adjustment') and l.organization_id is not distinct from p_org and l.payee_user is not distinct from u;
  select coalesce(sum(-l.amount_cents), 0) into paid from public.ledger_entries l where l.kind = 'payout' and l.organization_id is not distinct from p_org and l.payee_user is not distinct from u;
  select coalesce(sum(p.amount_cents), 0) into pending from public.payouts p where p.status in ('requested','approved') and p.organization_id is not distinct from p_org and p.user_id is not distinct from u;
  select coalesce(sum(d.amount_cents), 0) into disputed from public.disputes d join public.orders o on o.id = d.order_id join public.events e on e.id = o.event_id
   where d.status = 'open' and e.organization_id is not distinct from p_org and (p_org is not null or e.host = u);
  return jsonb_build_object('gross_sales_cents', gross, 'settled_sales_cents', settled, 'refunds_and_chargebacks_cents', -reductions, 'paid_out_cents', paid,
    'pending_payout_cents', pending, 'open_disputes_cents', disputed, 'balance_cents', gross + reductions - paid,
    'available_cents', greatest(0, settled + reductions - paid - pending - disputed), 'min_payout_cents', cfg.payout_min_cents, 'hold_days', cfg.settlement_hold_days);
end $$;

create or replace function public.request_payout(p_org uuid default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare bal jsonb; acct public.payout_accounts; new_id uuid; u uuid := case when p_org is null then auth.uid() end; amt bigint;
begin
  if not public.can_view_finance(p_org, u) or (p_org is not null and public.org_role(p_org) not in ('owner','admin') and not public.is_admin()) then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into acct from public.payout_accounts where organization_id is not distinct from p_org and user_id is not distinct from u;
  if not found or acct.status <> 'verified' then raise exception 'Add and verify a payout account first'; end if;
  if exists (select 1 from public.payouts where status in ('requested','approved') and organization_id is not distinct from p_org and user_id is not distinct from u) then raise exception 'You already have a payout in progress'; end if;
  bal := public.payout_balance(p_org); amt := (bal->>'available_cents')::bigint;
  if amt < (bal->>'min_payout_cents')::bigint or amt <= 0 then raise exception 'Available balance is below the minimum payout'; end if;
  insert into public.payouts (organization_id, user_id, amount_cents, requested_by) values (p_org, u, amt, auth.uid()) returning payouts.id into new_id;
  return new_id;
end $$;

create or replace function public.admin_decide_payout(p_payout uuid, p_approve boolean, p_note text default '') returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.payouts set status = case when p_approve then 'approved' else 'rejected' end, decided_by = auth.uid(), decided_at = now(), note = left(p_note, 500)
   where id = p_payout and status = 'requested';
  if not found then raise exception 'Payout is not awaiting a decision'; end if;
end $$;

create or replace function public.admin_mark_payout_paid(p_payout uuid, p_reference text) returns void
language plpgsql security definer set search_path = '' as $$
declare p public.payouts;
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.payouts set status = 'paid', paid_at = now(), bank_reference = left(p_reference, 120) where id = p_payout and status = 'approved' returning * into p;
  if not found then raise exception 'Payout must be approved first'; end if;
  insert into public.ledger_entries (organization_id, payee_user, payout_id, kind, amount_cents, note) values (p.organization_id, p.user_id, p.id, 'payout', -p.amount_cents, 'Payout ' || coalesce(p_reference, ''));
  insert into public.audit_log (actor, action, entity_type, entity_id, detail) values (auth.uid(), 'payout.paid', 'payout', p.id, jsonb_build_object('amount_cents', p.amount_cents));
end $$;

create or replace function public.admin_set_payout_account_status(p_account uuid, p_status text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_status not in ('verified','rejected') then raise exception 'bad status'; end if;
  update public.payout_accounts set status = p_status, updated_at = now() where id = p_account;
  insert into public.audit_log (actor, action, entity_type, entity_id) values (auth.uid(), 'payout_account.' || p_status, 'payout_account', p_account);
end $$;

-- Adjustments (goodwill credits, corrections) are admin-only and always carry a note.
create or replace function public.admin_add_adjustment(p_org uuid, p_user uuid, p_amount bigint, p_note text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if coalesce(p_note, '') = '' then raise exception 'A note is required'; end if;
  insert into public.ledger_entries (organization_id, payee_user, kind, amount_cents, note) values (p_org, p_user, 'adjustment', p_amount, left(p_note, 300));
  insert into public.audit_log (actor, action, entity_type, detail) values (auth.uid(), 'ledger.adjustment', 'ledger', jsonb_build_object('org', p_org, 'user', p_user, 'amount_cents', p_amount));
end $$;

-- Platform settings (fees, VAT, holds). Admin-only; table constraints validate every value.
create or replace function public.admin_get_config() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return (select to_jsonb(c) - 'id' from public.platform_config c where id);
end $$;
create or replace function public.admin_set_config(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.platform_config set
    fee_bps = coalesce((p->>'fee_bps')::int, fee_bps), fee_fixed_cents = coalesce((p->>'fee_fixed_cents')::int, fee_fixed_cents),
    hold_minutes = coalesce((p->>'hold_minutes')::int, hold_minutes), max_tickets_per_order = coalesce((p->>'max_tickets_per_order')::int, max_tickets_per_order),
    vat_registered = coalesce((p->>'vat_registered')::boolean, vat_registered), vat_rate_bps = coalesce((p->>'vat_rate_bps')::int, vat_rate_bps),
    vat_number = case when p ? 'vat_number' then nullif(p->>'vat_number', '') else vat_number end, legal_name = coalesce(nullif(p->>'legal_name', ''), legal_name),
    settlement_hold_days = coalesce((p->>'settlement_hold_days')::int, settlement_hold_days), payout_min_cents = coalesce((p->>'payout_min_cents')::int, payout_min_cents),
    buyer_refund_hours = coalesce((p->>'buyer_refund_hours')::int, buyer_refund_hours)
  where id;
  if (select vat_registered and vat_number is null from public.platform_config where id) then raise exception 'A VAT number is required when VAT-registered'; end if;
  insert into public.audit_log (actor, action, entity_type, detail) values (auth.uid(), 'platform_config.updated', 'platform_config', p);
  return (select to_jsonb(c) - 'id' from public.platform_config c where id);
end $$;

-- Aggregated numbers for the admin Finance overview (computed in SQL so it scales).
create or replace function public.admin_finance_summary(p_from timestamptz default now() - interval '30 days', p_to timestamptz default now()) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare r jsonb;
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  select jsonb_build_object(
    'paid_orders', count(*) filter (where status in ('paid','partially_refunded','refunded','disputed')),
    'ticket_sales_cents', coalesce(sum(subtotal_cents) filter (where status in ('paid','partially_refunded','refunded','disputed')), 0),
    'service_fees_cents', coalesce(sum(fee_cents) filter (where status in ('paid','partially_refunded','refunded','disputed')), 0),
    'service_fee_vat_cents', coalesce(sum(fee_vat_cents) filter (where status in ('paid','partially_refunded','refunded','disputed')), 0),
    'refunded_cents', coalesce(sum(refunded_cents), 0),
    'by_provider', coalesce((select jsonb_object_agg(provider, t) from (select provider, sum(total_cents) t from public.orders where status in ('paid','partially_refunded','refunded','disputed') and paid_at between p_from and p_to group by provider) x), '{}'::jsonb),
    'open_refunds', (select count(*) from public.refunds where status in ('requested','approved','processing','manual_required')),
    'open_disputes', (select count(*) from public.disputes where status = 'open'),
    'payouts_awaiting', (select count(*) from public.payouts where status in ('requested','approved')),
    'accounts_to_verify', (select count(*) from public.payout_accounts where status = 'pending')
  ) into r from public.orders where paid_at between p_from and p_to;
  return r;
end $$;
revoke execute on function public.admin_finance_summary(timestamptz, timestamptz) from public, anon;
grant execute on function public.admin_finance_summary(timestamptz, timestamptz) to authenticated;

-- Refunds stuck in "processing" (a function crashed mid-way) go back to the approved queue so they are retried, never lost.
create or replace function public.release_stuck_refunds() returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  update public.refunds set status = 'approved' where status = 'processing' and coalesce(processed_at, decided_at, created_at) < now() - interval '15 minutes';
  get diagnostics n = row_count; return n;
end $$;
revoke execute on function public.release_stuck_refunds() from public, anon, authenticated;
revoke execute on function public.admin_get_config(), public.admin_set_config(jsonb) from public, anon;
grant execute on function public.admin_get_config(), public.admin_set_config(jsonb) to authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then grant execute on function public.release_stuck_refunds() to service_role; end if;
  -- Housekeeping every few minutes when pg_cron is available (Supabase: Database → Extensions → pg_cron).
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('vybe-expire-orders', '*/5 * * * *', 'select public.expire_orders()');
    perform cron.schedule('vybe-release-refunds', '*/10 * * * *', 'select public.release_stuck_refunds()');
  end if;
exception when others then null;
end $$;

-- ------------------------------------------------------------------ grants
revoke execute on function public.create_order(uuid, jsonb, text, text) from public, anon;
grant execute on function public.create_order(uuid, jsonb, text, text) to authenticated;
revoke execute on function public.issue_tickets(uuid, text, text, text), public.fulfill_order(uuid, text, text, bigint, text),
  public.refund_claim(uuid), public.refund_finish(uuid, text, text, text, text) from public, anon, authenticated;
revoke execute on function public.issue_tickets(uuid, text, text), public.fulfill_order(uuid, text, text, bigint) from public, anon, authenticated;
revoke execute on function public.request_refund(uuid, text, uuid[]), public.decide_refund(uuid, boolean, text), public.cancel_event_with_refunds(uuid),
  public.admin_complete_refund(uuid, text), public.open_dispute(uuid, bigint, text), public.resolve_dispute(uuid, text, text), public.payout_balance(uuid),
  public.request_payout(uuid), public.admin_decide_payout(uuid, boolean, text), public.admin_mark_payout_paid(uuid, text),
  public.admin_set_payout_account_status(uuid, text), public.admin_add_adjustment(uuid, uuid, bigint, text) from public, anon;
grant execute on function public.request_refund(uuid, text, uuid[]), public.decide_refund(uuid, boolean, text), public.cancel_event_with_refunds(uuid),
  public.admin_complete_refund(uuid, text), public.open_dispute(uuid, bigint, text), public.resolve_dispute(uuid, text, text), public.payout_balance(uuid),
  public.request_payout(uuid), public.admin_decide_payout(uuid, boolean, text), public.admin_mark_payout_paid(uuid, text),
  public.admin_set_payout_account_status(uuid, text), public.admin_add_adjustment(uuid, uuid, bigint, text) to authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.fulfill_order(uuid, text, text, bigint, text), public.refund_claim(uuid), public.refund_finish(uuid, text, text, text, text) to service_role;
  end if;
end $$;
-- The older 4-argument versions from migration 6 are superseded; drop them so nothing can call the VAT-unaware path.
drop function if exists public.fulfill_order(uuid, text, text, bigint);
drop function if exists public.issue_tickets(uuid, text, text);
