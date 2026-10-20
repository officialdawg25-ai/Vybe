-- Aggregated numbers for the admin Finance overview (computed in SQL so it scales).
create or replace function public.admin_finance_summary(p_from timestamptz default now() - interval '30 days', p_to timestamptz default now()) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare r jsonb;
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  select jsonb_build_object(
    'paid_orders', count(*) filter (where status in ('paid','partially_refunded','refunded','disputed')),
    'ticket_sales_cents', coalesce(sum(subtotal_cents) filter (where status in ('paid','partially_refunded','refunded','disputed')), 0),
    'service_fees_cents', coalesce(sum(fee_cents) filter (where status in ('paid','partially_refunded','refunded','disputed')), 0),
    'service_fee_vat_cents', coalesce(sum(fee_vat_cents) filter (where status in ('paid','partially_refunded','refunded','disputed')), 0),
    'refunded_cents', coalesce(sum(refunded_cents), 0),
    'by_provider', coalesce((select jsonb_object_agg(provider, t) from (select provider, sum(total_cents) t from public.orders where status in ('paid','partially_refunded','refunded','disputed') and paid_at between p_from and p_to group by provider) x), '{}'::jsonb),
    'open_refunds', (select count(*) from public.refunds where status in ('requested','approved','processing','manual_required')),
    'open_disputes', (select count(*) from public.disputes where status = 'open'),
    'payouts_awaiting', (select count(*) from public.payouts where status in ('requested','approved')),
    'accounts_to_verify', (select count(*) from public.payout_accounts where status = 'pending')
  ) into r from public.orders where paid_at between p_from and p_to;
  return r;
end $$;

revoke execute on function public.admin_finance_summary(timestamptz, timestamptz) from public, anon;

grant execute on function public.admin_finance_summary(timestamptz, timestamptz) to authenticated;

-- Refunds stuck in "processing" (a function crashed mid-way) go back to the approved queue so they are retried, never lost.
create or replace function public.release_stuck_refunds() returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  update public.refunds set status = 'approved' where status = 'processing' and coalesce(processed_at, decided_at, created_at) < now() - interval '15 minutes';
  get diagnostics n = row_count; return n;
end $$;

revoke execute on function public.release_stuck_refunds() from public, anon, authenticated;

revoke execute on function public.admin_get_config(), public.admin_set_config(jsonb) from public, anon;

grant execute on function public.admin_get_config(), public.admin_set_config(jsonb) to authenticated;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then grant execute on function public.release_stuck_refunds() to service_role; end if;
  -- Housekeeping every few minutes when pg_cron is available (Supabase: Database → Extensions → pg_cron).
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('vybe-expire-orders', '*/5 * * * *', 'select public.expire_orders()');
    perform cron.schedule('vybe-release-refunds', '*/10 * * * *', 'select public.release_stuck_refunds()');
  end if;
exception when others then null;
end $$;

-- ------------------------------------------------------------------ grants
revoke execute on function public.create_order(uuid, jsonb, text, text) from public, anon;

grant execute on function public.create_order(uuid, jsonb, text, text) to authenticated;

revoke execute on function public.issue_tickets(uuid, text, text, text), public.fulfill_order(uuid, text, text, bigint, text),
  public.refund_claim(uuid), public.refund_finish(uuid, text, text, text, text) from public, anon, authenticated;

revoke execute on function public.issue_tickets(uuid, text, text), public.fulfill_order(uuid, text, text, bigint) from public, anon, authenticated;
