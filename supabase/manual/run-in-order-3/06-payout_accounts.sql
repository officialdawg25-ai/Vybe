-- 06-payout_accounts.sql: run in filename order (live streaming, finance). Re-runnable.
alter table public.payout_accounts enable row level security;

alter table public.payouts enable row level security;

alter table public.ledger_entries enable row level security;

alter table public.invoices enable row level security;

drop policy if exists refunds_select on public.refunds;

create policy refunds_select on public.refunds for select to authenticated
  using (requested_by = auth.uid() or public.is_admin()
         or exists (select 1 from public.orders o where o.id = order_id and (o.buyer = auth.uid() or public.can_manage_event(o.event_id))));

drop policy if exists disputes_select on public.disputes;

create policy disputes_select on public.disputes for select to authenticated using (public.is_admin());

drop policy if exists flags_select on public.buyer_flags;

create policy flags_select on public.buyer_flags for select to authenticated using (public.is_admin());

drop policy if exists pa_select on public.payout_accounts;

create policy pa_select on public.payout_accounts for select to authenticated using (public.can_view_finance(organization_id, user_id));

drop policy if exists payouts_select on public.payouts;

create policy payouts_select on public.payouts for select to authenticated using (public.can_view_finance(organization_id, user_id));

drop policy if exists ledger_select on public.ledger_entries;

create policy ledger_select on public.ledger_entries for select to authenticated using (public.can_view_finance(organization_id, payee_user));

drop policy if exists invoices_select on public.invoices;

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
