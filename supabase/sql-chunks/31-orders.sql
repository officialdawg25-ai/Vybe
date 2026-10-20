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
