-- 14-misc.sql: run in filename order (live streaming, finance). Re-runnable.
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.fulfill_order(uuid, text, text, bigint, text), public.refund_claim(uuid), public.refund_finish(uuid, text, text, text, text) to service_role;
  end if;
end $$;

-- The older 4-argument versions from migration 6 are superseded; drop them so nothing can call the VAT-unaware path.
drop function if exists public.fulfill_order(uuid, text, text, bigint);

drop function if exists public.issue_tickets(uuid, text, text);
