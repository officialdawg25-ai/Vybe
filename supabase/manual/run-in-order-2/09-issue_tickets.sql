-- 09-issue_tickets.sql: run in filename order (voice notes, onboarding data, events near you, tickets). Re-runnable.
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
