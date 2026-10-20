-- VYBE: onboarding data, location-aware events, lineups, organization posts, and ticketing (PayFast / Ozow ready).
-- Additive and re-runnable. Money handling rules:
--   * Orders are created ONLY through create_order(): prices, fees, limits and inventory are decided here, never by the client.
--   * Orders become paid ONLY through fulfill_order(), executable by the service role (the payment webhook worker) alone.
--   * Tickets are issued inside that single transaction; check-in is an atomic single-use update.

-- ------------------------------------------------------------ profiles (onboarding)
-- `profiles` is readable by every signed-in user, so it only gets non-sensitive, city-level data. Anything personal
-- (birth date, consent record) lives in `profile_private`, readable and writable by its owner alone.
alter table public.profiles add column if not exists country text check (country is null or char_length(country) <= 80);
alter table public.profiles add column if not exists lat double precision check (lat is null or lat between -90 and 90);   -- city centre, never a street address
alter table public.profiles add column if not exists lng double precision check (lng is null or lng between -180 and 180);
alter table public.profiles add column if not exists intents text[] not null default '{}' check (cardinality(intents) <= 8);
alter table public.profiles add column if not exists onboarding_step integer not null default 0 check (onboarding_step between 0 and 20);
grant update (country, lat, lng, intents, onboarding_step) on public.profiles to authenticated;

create table if not exists public.profile_private (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  birth_date date,
  terms_accepted_at timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.profile_private enable row level security;
drop policy if exists pp_select on public.profile_private;
create policy pp_select on public.profile_private for select to authenticated using (user_id = auth.uid());
drop policy if exists pp_insert on public.profile_private;
create policy pp_insert on public.profile_private for insert to authenticated with check (user_id = auth.uid());
drop policy if exists pp_update on public.profile_private;
create policy pp_update on public.profile_private for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
revoke all on public.profile_private from anon, authenticated;
grant select on public.profile_private to authenticated;
grant insert (user_id, birth_date, terms_accepted_at) on public.profile_private to authenticated;
grant update (birth_date, terms_accepted_at) on public.profile_private to authenticated;

-- Minimum age 13, enforced server-side.
create or replace function public.trg_profile_age() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.birth_date is not null and new.birth_date > (current_date - interval '13 years')::date then
    raise exception 'You must be at least 13 to use VYBE' using errcode = '22023';
  end if;
  if new.birth_date is not null and new.birth_date < date '1900-01-01' then
    raise exception 'Invalid birth date' using errcode = '22023';
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists profile_age on public.profile_private;
create trigger profile_age before insert or update on public.profile_private for each row execute function public.trg_profile_age();

-- ------------------------------------------------------------ events: where
alter table public.events add column if not exists city text check (city is null or char_length(city) <= 80);
alter table public.events add column if not exists country text check (country is null or char_length(country) <= 80);
alter table public.events add column if not exists venue text check (venue is null or char_length(venue) <= 120);
alter table public.events add column if not exists address text check (address is null or char_length(address) <= 240);
alter table public.events add column if not exists lat double precision check (lat is null or lat between -90 and 90);
alter table public.events add column if not exists lng double precision check (lng is null or lng between -180 and 180);
create index if not exists events_geo_idx on public.events (lat, lng) where lat is not null;
grant update (city, country, venue, address, lat, lng) on public.events to authenticated;
grant insert (city, country, venue, address, lat, lng) on public.events to authenticated;

-- Events near a point (bounding box first, exact great-circle distance second). SECURITY INVOKER: RLS still decides
-- what each viewer may see, so private and invite-only events never leak through discovery.
create or replace function public.events_near(p_lat double precision, p_lng double precision, p_radius_km double precision default 50,
                                              p_from timestamptz default now(), p_to timestamptz default null, p_q text default null)
returns setof public.events
language sql stable security invoker set search_path = '' as $$
  select e.* from public.events e
  where e.status = 'active' and e.visibility = 'public' and e.lat is not null and e.lng is not null
    and coalesce(e.ends_at, e.starts_at + interval '4 hours') >= p_from
    and (p_to is null or e.starts_at <= p_to)
    and e.lat between p_lat - (least(p_radius_km, 500) / 111.0) and p_lat + (least(p_radius_km, 500) / 111.0)
    and e.lng between p_lng - (least(p_radius_km, 500) / (111.0 * greatest(0.05, cos(radians(p_lat)))))
                  and p_lng + (least(p_radius_km, 500) / (111.0 * greatest(0.05, cos(radians(p_lat)))))
    and 6371 * 2 * asin(least(1, sqrt(power(sin(radians(e.lat - p_lat) / 2), 2)
          + cos(radians(p_lat)) * cos(radians(e.lat)) * power(sin(radians(e.lng - p_lng) / 2), 2)))) <= least(p_radius_km, 500)
    and (p_q is null or p_q = '' or e.title ilike '%' || replace(replace(p_q, '%', ''), '_', '') || '%')
  order by e.starts_at
  limit 80;
$$;
grant execute on function public.events_near(double precision, double precision, double precision, timestamptz, timestamptz, text) to authenticated;

-- ------------------------------------------------------------ helpers
create or replace function public.can_manage_event(eid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.events e where e.id = eid
    and (e.host = auth.uid() or (e.organization_id is not null and public.org_role(e.organization_id) in ('owner','admin','editor'))));
$$;
create or replace function public.can_view_event_id(eid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select public.can_view_event(e) from public.events e where e.id = eid), false);
$$;
revoke execute on function public.can_manage_event(uuid), public.can_view_event_id(uuid) from public, anon;
grant execute on function public.can_manage_event(uuid), public.can_view_event_id(uuid) to authenticated;

-- ------------------------------------------------------------ organization (page) posts
alter table public.posts add column if not exists organization_id uuid references public.organizations(id) on delete set null;
create index if not exists posts_org_idx on public.posts (organization_id, created_at desc) where organization_id is not null;
drop policy if exists posts_insert on public.posts;
create policy posts_insert on public.posts for insert to authenticated
  with check (
    author = auth.uid()
    and (community_id is null or public.is_community_member(community_id))
    and (media_path is null or media_path like auth.uid()::text || '/%')
    and (organization_id is null or (public.org_role(organization_id) in ('owner','admin','editor') and visibility = 'public'))
  );
grant insert (organization_id) on public.posts to authenticated;

-- ------------------------------------------------------------ lineup (artists, guests, hosts)
create table if not exists public.event_lineup (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  role text not null default 'Guest' check (char_length(role) between 1 and 40),
  bio text not null default '' check (char_length(bio) <= 300),
  image_path text,
  sort integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists event_lineup_event_idx on public.event_lineup (event_id, sort);
alter table public.event_lineup enable row level security;
drop policy if exists lineup_select on public.event_lineup;
create policy lineup_select on public.event_lineup for select to authenticated using (public.can_view_event_id(event_id));
drop policy if exists lineup_insert on public.event_lineup;
create policy lineup_insert on public.event_lineup for insert to authenticated with check (public.can_manage_event(event_id));
drop policy if exists lineup_update on public.event_lineup;
create policy lineup_update on public.event_lineup for update to authenticated using (public.can_manage_event(event_id)) with check (public.can_manage_event(event_id));
drop policy if exists lineup_delete on public.event_lineup;
create policy lineup_delete on public.event_lineup for delete to authenticated using (public.can_manage_event(event_id));
revoke all on public.event_lineup from anon, authenticated;
grant select, delete on public.event_lineup to authenticated;
grant insert (event_id, name, role, bio, image_path, sort) on public.event_lineup to authenticated;
grant update (name, role, bio, image_path, sort) on public.event_lineup to authenticated;

-- Lineup photos are visible wherever the event is.
drop policy if exists media_select_visible on storage.objects;
create policy media_select_visible on storage.objects for select to authenticated
  using (
    bucket_id = 'media' and (
      (storage.foldername(name))[1] = auth.uid()::text
      or exists (select 1 from public.posts p where p.media_path = name)
      or exists (select 1 from public.comments c where c.audio_path = name)
      or exists (select 1 from public.profiles pr where pr.avatar_path = name)
      or exists (select 1 from public.events e where e.cover_path = name)
      or exists (select 1 from public.event_lineup l where l.image_path = name)
      or exists (select 1 from public.communities c where c.cover_path = name)
    )
  );

-- ------------------------------------------------------------ ticketing
-- Platform fee settings live in one row that clients can never read or write (only definer functions and the service role).
create table if not exists public.platform_config (
  id boolean primary key default true check (id),
  fee_bps integer not null default 500 check (fee_bps between 0 and 3000),          -- 5.00 % service fee added to the buyer's total
  fee_fixed_cents integer not null default 300 check (fee_fixed_cents between 0 and 5000), -- + R3.00 per paid order
  hold_minutes integer not null default 15 check (hold_minutes between 5 and 60),
  max_tickets_per_order integer not null default 20 check (max_tickets_per_order between 1 and 100)
);
insert into public.platform_config (id) values (true) on conflict (id) do nothing;
alter table public.platform_config enable row level security;
revoke all on public.platform_config from anon, authenticated;

create table if not exists public.ticket_types (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  description text not null default '' check (char_length(description) <= 300),
  kind text not null default 'single' check (kind in ('single','group')),
  group_size integer not null default 1 check (group_size between 1 and 20),       -- tickets issued per unit bought
  price_cents integer not null check (price_cents between 0 and 5000000),         -- per unit, ZAR cents
  currency text not null default 'ZAR' check (currency = 'ZAR'),
  quantity_total integer not null check (quantity_total between 1 and 100000),    -- units for sale
  max_per_order integer not null default 10 check (max_per_order between 1 and 20),
  sales_start timestamptz,
  sales_end timestamptz,
  status text not null default 'active' check (status in ('active','paused')),
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  check ((kind = 'single' and group_size = 1) or kind = 'group'),
  check (sales_end is null or sales_start is null or sales_end > sales_start)
);
create index if not exists ticket_types_event_idx on public.ticket_types (event_id, sort);

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  buyer uuid not null references public.profiles(id) on delete restrict,
  event_id uuid not null references public.events(id) on delete restrict,
  status text not null default 'pending' check (status in ('pending','paid','failed','cancelled','expired','refunded')),
  provider text check (provider in ('payfast','ozow','free')),
  provider_ref text,
  subtotal_cents bigint not null check (subtotal_cents >= 0),
  fee_cents bigint not null default 0 check (fee_cents >= 0),
  total_cents bigint not null check (total_cents >= 0),
  currency text not null default 'ZAR' check (currency = 'ZAR'),
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 80),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  paid_at timestamptz,
  unique (buyer, idempotency_key),
  check (total_cents = subtotal_cents + fee_cents)
);
create index if not exists orders_buyer_idx on public.orders (buyer, created_at desc);
create index if not exists orders_event_idx on public.orders (event_id, status);
create unique index if not exists orders_provider_ref_key on public.orders (provider, provider_ref) where provider_ref is not null;

create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  ticket_type_id uuid not null references public.ticket_types(id) on delete restrict,
  qty integer not null check (qty between 1 and 20),
  unit_price_cents integer not null check (unit_price_cents >= 0)
);
create index if not exists order_items_order_idx on public.order_items (order_id);
create index if not exists order_items_type_idx on public.order_items (ticket_type_id);

create table if not exists public.tickets (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete restrict,
  event_id uuid not null references public.events(id) on delete restrict,
  ticket_type_id uuid not null references public.ticket_types(id) on delete restrict,
  owner uuid not null references public.profiles(id) on delete restrict,
  code text not null unique check (code ~ '^[A-Z0-9]{20}$'),
  status text not null default 'valid' check (status in ('valid','used','void')),
  transfers integer not null default 0 check (transfers between 0 and 1),           -- one transfer maximum (anti-scalping)
  used_at timestamptz,
  used_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists tickets_owner_idx on public.tickets (owner, created_at desc);
create index if not exists tickets_event_idx on public.tickets (event_id, status);

alter table public.ticket_types enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.tickets enable row level security;

drop policy if exists tt_select on public.ticket_types;
create policy tt_select on public.ticket_types for select to authenticated using (public.can_view_event_id(event_id));
drop policy if exists tt_insert on public.ticket_types;
create policy tt_insert on public.ticket_types for insert to authenticated with check (public.can_manage_event(event_id));
drop policy if exists tt_update on public.ticket_types;
create policy tt_update on public.ticket_types for update to authenticated using (public.can_manage_event(event_id)) with check (public.can_manage_event(event_id));
drop policy if exists tt_delete on public.ticket_types;
create policy tt_delete on public.ticket_types for delete to authenticated
  using (public.can_manage_event(event_id) and not exists (select 1 from public.order_items oi where oi.ticket_type_id = ticket_types.id));

drop policy if exists orders_select on public.orders;
create policy orders_select on public.orders for select to authenticated using (buyer = auth.uid() or public.can_manage_event(event_id));
drop policy if exists oi_select on public.order_items;
create policy oi_select on public.order_items for select to authenticated
  using (exists (select 1 from public.orders o where o.id = order_id and (o.buyer = auth.uid() or public.can_manage_event(o.event_id))));
drop policy if exists tickets_select on public.tickets;
create policy tickets_select on public.tickets for select to authenticated using (owner = auth.uid() or public.can_manage_event(event_id));

revoke all on public.ticket_types, public.orders, public.order_items, public.tickets from anon, authenticated;
grant select on public.ticket_types, public.orders, public.order_items, public.tickets to authenticated;
grant insert (event_id, name, description, kind, group_size, price_cents, quantity_total, max_per_order, sales_start, sales_end, status, sort) on public.ticket_types to authenticated;
grant update (name, description, price_cents, quantity_total, max_per_order, sales_start, sales_end, status, sort) on public.ticket_types to authenticated;
grant delete on public.ticket_types to authenticated;

-- Units of a ticket type currently sold or held by an unexpired pending order.
create or replace function public.ticket_units_taken(tt uuid) returns bigint
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(oi.qty), 0) from public.order_items oi join public.orders o on o.id = oi.order_id
  where oi.ticket_type_id = tt and (o.status = 'paid' or (o.status = 'pending' and o.expires_at > now()));
$$;
revoke execute on function public.ticket_units_taken(uuid) from public, anon;
grant execute on function public.ticket_units_taken(uuid) to authenticated;

-- Creates an order. p_items: [{"ticket_type_id": "...", "qty": 2}, ...]. Returns the order as JSON.
create or replace function public.create_order(p_event uuid, p_items jsonb, p_provider text, p_idem text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid(); ev public.events; cfg public.platform_config; ord public.orders;
  it jsonb; tt public.ticket_types; q integer; subtotal bigint := 0; fee bigint := 0; total_units integer := 0; mine integer;
begin
  if uid is null then raise exception 'Sign in to buy tickets' using errcode = '28000'; end if;
  if p_provider is null or p_provider not in ('payfast','ozow') then raise exception 'Choose PayFast or Ozow'; end if;
  if p_idem is null or char_length(p_idem) < 8 then raise exception 'Missing idempotency key'; end if;
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) not between 1 and 10 then raise exception 'Choose at least one ticket'; end if;

  select * into ord from public.orders where buyer = uid and idempotency_key = p_idem;      -- safe replays after a network drop
  if found then return jsonb_build_object('id', ord.id, 'status', ord.status, 'total_cents', ord.total_cents, 'fee_cents', ord.fee_cents, 'subtotal_cents', ord.subtotal_cents, 'expires_at', ord.expires_at); end if;

  select * into cfg from public.platform_config where id;
  select * into ev from public.events e where e.id = p_event;
  if not found or ev.status <> 'active' or not public.can_view_event(ev) then raise exception 'This event is not available'; end if;
  if coalesce(ev.ends_at, ev.starts_at + interval '6 hours') < now() then raise exception 'This event has ended'; end if;

  -- Velocity limits: slows card testing, scalping bots and inventory-hoarding.
  if (select count(*) from public.orders where buyer = uid and created_at > now() - interval '10 minutes') >= 6 then raise exception 'Too many attempts. Please wait a few minutes.'; end if;
  if (select count(*) from public.orders where buyer = uid and created_at > now() - interval '24 hours') >= 30 then raise exception 'Daily purchase limit reached.'; end if;
  if (select count(*) from public.orders where buyer = uid and status = 'pending' and expires_at > now()) >= 3 then raise exception 'Finish or cancel your pending orders first.'; end if;

  for it in select * from jsonb_array_elements(p_items) loop
    q := (it->>'qty')::integer;
    select * into tt from public.ticket_types where id = (it->>'ticket_type_id')::uuid and event_id = p_event for update;   -- row lock serialises inventory
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
  select count(*) into mine from public.tickets where owner = uid and event_id = p_event and status <> 'void';
  if mine + total_units > 20 then raise exception 'Ticket limit per person reached for this event'; end if;

  if subtotal > 0 then fee := ceil(subtotal * cfg.fee_bps / 10000.0)::bigint + cfg.fee_fixed_cents; end if;
  if subtotal + fee > 0 and subtotal + fee < 500 then raise exception 'The minimum card/EFT payment is R5.00'; end if;

  insert into public.orders (buyer, event_id, provider, subtotal_cents, fee_cents, total_cents, idempotency_key, expires_at)
  values (uid, p_event, case when subtotal = 0 then 'free' else p_provider end, subtotal, fee, subtotal + fee, p_idem, now() + make_interval(mins => cfg.hold_minutes))
  returning * into ord;
  for it in select * from jsonb_array_elements(p_items) loop
    insert into public.order_items (order_id, ticket_type_id, qty, unit_price_cents)
    select ord.id, t.id, (it->>'qty')::integer, t.price_cents from public.ticket_types t where t.id = (it->>'ticket_type_id')::uuid;
  end loop;

  if ord.total_cents = 0 then perform public.issue_tickets(ord.id, 'free', null); select * into ord from public.orders where id = ord.id; end if;
  return jsonb_build_object('id', ord.id, 'status', ord.status, 'total_cents', ord.total_cents, 'fee_cents', ord.fee_cents, 'subtotal_cents', ord.subtotal_cents, 'expires_at', ord.expires_at);
end $$;

-- Marks an order paid and creates its tickets (idempotent). Internal: called by fulfill_order and by free orders.
create or replace function public.issue_tickets(p_order uuid, p_provider text, p_ref text) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.orders; r record; n integer; k integer;
begin
  select * into o from public.orders where id = p_order for update;
  if not found then raise exception 'order not found'; end if;
  if o.status = 'paid' then return; end if;
  if o.status not in ('pending','expired') then raise exception 'order is %', o.status; end if;
  -- A payment that lands after the hold lapsed is honoured only while stock remains; otherwise it is flagged for refund.
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
  update public.orders set status = 'paid', provider = p_provider, provider_ref = coalesce(p_ref, provider_ref), paid_at = now() where id = o.id;
  begin   -- being a ticket holder means you are going
    insert into public.event_rsvps (event_id, user_id, status) values (o.event_id, o.buyer, 'going')
    on conflict (event_id, user_id) do update set status = 'going';
  exception when others then null;
  end;
end $$;

-- Called by the payment webhook worker (service role) after it has verified the provider's signature and amount.
create or replace function public.fulfill_order(p_order uuid, p_provider text, p_ref text, p_amount_cents bigint) returns void
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
  perform public.issue_tickets(p_order, p_provider, p_ref);
end $$;

-- Marks failed/cancelled payments and expires stale holds (called by the worker on notify/return and by a scheduled sweep).
create or replace function public.close_order(p_order uuid, p_status text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_status not in ('failed','cancelled') then raise exception 'bad status'; end if;
  update public.orders set status = p_status where id = p_order and status = 'pending';
end $$;
create or replace function public.expire_orders() returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  update public.orders set status = 'expired' where status = 'pending' and expires_at < now();
  get diagnostics n = row_count; return n;
end $$;

revoke execute on function public.issue_tickets(uuid, text, text), public.fulfill_order(uuid, text, text, bigint), public.close_order(uuid, text), public.expire_orders() from public, anon, authenticated;
revoke execute on function public.create_order(uuid, jsonb, text, text) from public, anon;
grant execute on function public.create_order(uuid, jsonb, text, text) to authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.fulfill_order(uuid, text, text, bigint), public.close_order(uuid, text), public.expire_orders() to service_role;
  end if;
end $$;

-- A buyer cancels their own unpaid order (releases the hold immediately).
create or replace function public.cancel_my_order(p_order uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.orders set status = 'cancelled' where id = p_order and buyer = auth.uid() and status = 'pending';
end $$;
revoke execute on function public.cancel_my_order(uuid) from public, anon;
grant execute on function public.cancel_my_order(uuid) to authenticated;

-- One transfer per ticket, only while valid and before the event is over; the new holder must be a friend of the sender.
create or replace function public.transfer_ticket(p_ticket uuid, p_to uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare t public.tickets; ev public.events;
begin
  select * into t from public.tickets where id = p_ticket for update;
  if not found or t.owner <> auth.uid() then raise exception 'Ticket not found'; end if;
  if t.status <> 'valid' then raise exception 'This ticket can no longer be transferred'; end if;
  if t.transfers >= 1 then raise exception 'This ticket has already been transferred once'; end if;
  select * into ev from public.events where id = t.event_id;
  if coalesce(ev.ends_at, ev.starts_at + interval '6 hours') < now() then raise exception 'This event has ended'; end if;
  if p_to = auth.uid() or not public.are_friends(auth.uid(), p_to) then raise exception 'You can only transfer tickets to friends'; end if;
  update public.tickets set owner = p_to, transfers = transfers + 1 where id = p_ticket;
  insert into public.audit_log (actor, action, entity_type, entity_id, detail) values (auth.uid(), 'ticket.transferred', 'ticket', p_ticket, jsonb_build_object('to', p_to));
end $$;
revoke execute on function public.transfer_ticket(uuid, uuid) from public, anon;
grant execute on function public.transfer_ticket(uuid, uuid) to authenticated;

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
