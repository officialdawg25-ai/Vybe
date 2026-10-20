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
