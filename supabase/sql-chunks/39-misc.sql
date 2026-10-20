do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.live_apply_event(text, text, integer) to service_role;
  end if;
end $$;

-- Finance: VAT, receipts/tax invoices, refunds, chargebacks, an append-only ledger, organizer payout accounts and payouts.
-- Additive and re-runnable. Principles:
--   * Money only moves through these functions; every movement is an immutable ledger row.
--   * Clients never write money tables. Gateway calls happen in edge functions (service role); humans approve in the portals.
--   * Organizer bank details are stored ENCRYPTED by an edge function; the API never exposes the ciphertext.

alter table public.platform_config add column if not exists vat_registered boolean not null default false;

alter table public.platform_config add column if not exists vat_rate_bps integer not null default 1500 check (vat_rate_bps between 0 and 5000);

alter table public.platform_config add column if not exists vat_number text check (vat_number is null or char_length(vat_number) <= 30);

alter table public.platform_config add column if not exists legal_name text not null default 'VYBE' check (char_length(legal_name) <= 120);

alter table public.platform_config add column if not exists settlement_hold_days integer not null default 3 check (settlement_hold_days between 0 and 30);

alter table public.platform_config add column if not exists payout_min_cents integer not null default 10000 check (payout_min_cents >= 0);

alter table public.platform_config add column if not exists buyer_refund_hours integer not null default 48 check (buyer_refund_hours between 0 and 720);

alter table public.orders add column if not exists fee_vat_cents bigint not null default 0 check (fee_vat_cents >= 0);

alter table public.orders add column if not exists refunded_cents bigint not null default 0 check (refunded_cents >= 0);

alter table public.orders add column if not exists payment_method text;

alter table public.orders add column if not exists ip_hash text;

alter table public.orders drop constraint if exists orders_status_check;

alter table public.orders add constraint orders_status_check
  check (status in ('pending','paid','failed','cancelled','expired','refunded','partially_refunded','disputed'));

alter table public.tickets drop constraint if exists tickets_status_check;

alter table public.tickets add constraint tickets_status_check check (status in ('valid','used','void','refunded'));

alter table public.tickets add column if not exists void_reason text;

-- ------------------------------------------------------------------ who gets paid, who may see the money
create or replace function public.event_payee(eid uuid, out org uuid, out usr uuid)
language sql stable security definer set search_path = '' as $$
  select e.organization_id, case when e.organization_id is null then e.host end from public.events e where e.id = eid;
$$;

create or replace function public.can_view_finance(p_org uuid, p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.is_admin() or (p_user is not null and p_user = auth.uid()) or (p_org is not null and public.org_role(p_org) in ('owner','admin'));
$$;

revoke execute on function public.event_payee(uuid), public.can_view_finance(uuid, uuid) from public, anon;

grant execute on function public.event_payee(uuid), public.can_view_finance(uuid, uuid) to authenticated;
