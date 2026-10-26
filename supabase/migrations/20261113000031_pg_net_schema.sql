-- Migration 31: pg_net belongs in the extensions schema (security advisor "extension_in_public"). Update 30 first
-- installed it in public on the live project; migration 30 now installs it in extensions for new databases.
-- Only the 'vybe-email' cron job uses it (net.http_post lives in schema net either way), so recreating it is safe.
do $$ begin
  if exists (select 1 from pg_extension e join pg_namespace n on n.oid = e.extnamespace where e.extname = 'pg_net' and n.nspname = 'public') then
    drop extension pg_net;
    create extension pg_net with schema extensions;
  end if;
end $$;
