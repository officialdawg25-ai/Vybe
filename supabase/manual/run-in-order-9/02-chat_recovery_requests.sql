create unique index if not exists chat_recovery_one_active on public.chat_recovery_requests (user_id) where status = 'waiting';

create index if not exists chat_recovery_user_idx on public.chat_recovery_requests (user_id, created_at desc);

alter table public.chat_recovery_requests enable row level security;

drop policy if exists chat_recovery_own on public.chat_recovery_requests;

create policy chat_recovery_own on public.chat_recovery_requests for select to authenticated using (user_id = auth.uid());

revoke all on public.chat_recovery_requests from anon, authenticated;

grant select on public.chat_recovery_requests to authenticated;

-- Direct writes are closed: keys change only through the functions below (audited, rate-limited, owner alerted).
revoke insert, update, delete on public.chat_keys from authenticated;

drop policy if exists chat_keys_insert on public.chat_keys;

drop policy if exists chat_keys_update on public.chat_keys;

revoke insert, update, delete on public.chat_key_backups from authenticated;

drop policy if exists chat_key_backups_own on public.chat_key_backups;

create policy chat_key_backups_own on public.chat_key_backups for select to authenticated using (user_id = auth.uid());

create or replace function public.publish_chat_key(p_public text, p_backup jsonb, p_recovery jsonb default null) returns void
language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid(); had boolean; recent integer;
begin
  if me is null then raise exception 'Sign in' using errcode = '28000'; end if;
  if p_public !~ '^[A-Za-z0-9+/]{80,200}=*$' then raise exception 'Invalid key'; end if;
  if jsonb_typeof(p_backup) is distinct from 'object' or pg_column_size(p_backup) >= 4096 then raise exception 'Invalid backup'; end if;
  if p_recovery is not null and (jsonb_typeof(p_recovery) is distinct from 'object' or pg_column_size(p_recovery) >= 4096) then raise exception 'Invalid recovery backup'; end if;
  select count(*) into recent from public.chat_key_events where user_id = me and action in ('create', 'rotate') and created_at > now() - interval '1 hour';
  if recent >= 5 then raise exception 'Too many key changes. Please wait a while.'; end if;
  select exists (select 1 from public.chat_keys where user_id = me) into had;
  insert into public.chat_keys (user_id, public_key) values (me, p_public)
    on conflict (user_id) do update set public_key = excluded.public_key, updated_at = now();
  insert into public.chat_key_backups (user_id, backup, recovery, escrow) values (me, p_backup, p_recovery, false)
    on conflict (user_id) do update set backup = excluded.backup, recovery = excluded.recovery, escrow = false, updated_at = now();
  -- A new key makes the old escrow copy and any recovery in progress meaningless (and dangerous), so both go.
  delete from public.chat_key_escrow where user_id = me;
  update public.chat_recovery_requests set status = 'cancelled', updated_at = now() where user_id = me and status = 'waiting';
  insert into public.chat_key_events (user_id, action) values (me, case when had then 'rotate' else 'create' end);
  if had then perform public.notify(me, 'security', null, 'profile', me, 'ck:' || gen_random_uuid()); end if;
end $$;
