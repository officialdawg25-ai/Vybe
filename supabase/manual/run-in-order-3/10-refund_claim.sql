-- 10-refund_claim.sql: run in filename order (live streaming, finance). Re-runnable.
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
