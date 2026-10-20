-- 11-resolve_dispute.sql: run in filename order (live streaming, finance). Re-runnable.
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
