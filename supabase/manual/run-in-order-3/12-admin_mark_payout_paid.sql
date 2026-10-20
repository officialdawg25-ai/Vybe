-- 12-admin_mark_payout_paid.sql: run in filename order (live streaming, finance). Re-runnable.
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
