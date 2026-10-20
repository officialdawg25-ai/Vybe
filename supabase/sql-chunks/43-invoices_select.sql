create policy invoices_select on public.invoices for select to authenticated using (buyer = auth.uid() or public.is_admin());

drop policy if exists orders_admin_select on public.orders;

create policy orders_admin_select on public.orders for select to authenticated using (public.is_admin());

revoke all on public.refunds, public.disputes, public.buyer_flags, public.payout_accounts, public.payouts, public.ledger_entries, public.invoices from anon, authenticated;

grant select on public.refunds, public.disputes, public.buyer_flags, public.payouts, public.ledger_entries, public.invoices to authenticated;

-- The encrypted bank details are never selectable through the API.
grant select (id, organization_id, user_id, holder, bank, account_last4, status, created_at, updated_at) on public.payout_accounts to authenticated;

-- Stock held: paid and partially refunded orders (refunded / disputed ones release it), plus unexpired pending holds.
create or replace function public.ticket_units_taken(tt uuid) returns bigint
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(oi.qty), 0) from public.order_items oi join public.orders o on o.id = oi.order_id
  where oi.ticket_type_id = tt and (o.status in ('paid','partially_refunded') or (o.status = 'pending' and o.expires_at > now()));
$$;
