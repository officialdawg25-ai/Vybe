create table if not exists public.invoices (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references public.orders(id) on delete restrict,
  buyer uuid not null references public.profiles(id) on delete restrict,
  number text not null unique,
  kind text not null check (kind in ('receipt','tax_invoice')),
  issued_at timestamptz not null default now(),
  legal_name text not null,
  vat_number text,
  buyer_name text not null default '',
  lines jsonb not null,
  subtotal_cents bigint not null,
  fee_cents bigint not null,
  fee_vat_cents bigint not null default 0,
  total_cents bigint not null
);

create sequence if not exists public.invoice_seq;

alter table public.refunds enable row level security;

alter table public.disputes enable row level security;

alter table public.buyer_flags enable row level security;

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
