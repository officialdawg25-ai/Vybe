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
