revoke execute on function public.fulfill_badge_order(uuid, text, text, bigint), public.close_badge_order(uuid, text) from authenticated;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.fulfill_badge_order(uuid, text, text, bigint), public.close_badge_order(uuid, text) to service_role;
  end if;
end $$;
