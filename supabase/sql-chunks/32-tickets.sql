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
