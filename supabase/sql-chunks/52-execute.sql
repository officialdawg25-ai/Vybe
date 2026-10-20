revoke execute on function public.request_refund(uuid, text, uuid[]), public.decide_refund(uuid, boolean, text), public.cancel_event_with_refunds(uuid),
  public.admin_complete_refund(uuid, text), public.open_dispute(uuid, bigint, text), public.resolve_dispute(uuid, text, text), public.payout_balance(uuid),
  public.request_payout(uuid), public.admin_decide_payout(uuid, boolean, text), public.admin_mark_payout_paid(uuid, text),
  public.admin_set_payout_account_status(uuid, text), public.admin_add_adjustment(uuid, uuid, bigint, text) from public, anon;

grant execute on function public.request_refund(uuid, text, uuid[]), public.decide_refund(uuid, boolean, text), public.cancel_event_with_refunds(uuid),
  public.admin_complete_refund(uuid, text), public.open_dispute(uuid, bigint, text), public.resolve_dispute(uuid, text, text), public.payout_balance(uuid),
  public.request_payout(uuid), public.admin_decide_payout(uuid, boolean, text), public.admin_mark_payout_paid(uuid, text),
  public.admin_set_payout_account_status(uuid, text), public.admin_add_adjustment(uuid, uuid, bigint, text) to authenticated;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.fulfill_order(uuid, text, text, bigint, text), public.refund_claim(uuid), public.refund_finish(uuid, text, text, text, text) to service_role;
  end if;
end $$;

-- The older 4-argument versions from migration 6 are superseded; drop them so nothing can call the VAT-unaware path.
drop function if exists public.fulfill_order(uuid, text, text, bigint);

drop function if exists public.issue_tickets(uuid, text, text);
