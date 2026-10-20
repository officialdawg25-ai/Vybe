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
