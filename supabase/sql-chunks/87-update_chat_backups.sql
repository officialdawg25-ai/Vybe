-- Change the passphrase backup and/or the recovery-key backup of the key already published (the public key does not change).
create or replace function public.update_chat_backups(p_backup jsonb default null, p_recovery jsonb default null) returns void
language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid(); recent integer;
begin
  if me is null then raise exception 'Sign in' using errcode = '28000'; end if;
  if p_backup is null and p_recovery is null then return; end if;
  if (p_backup is not null and (jsonb_typeof(p_backup) is distinct from 'object' or pg_column_size(p_backup) >= 4096))
     or (p_recovery is not null and (jsonb_typeof(p_recovery) is distinct from 'object' or pg_column_size(p_recovery) >= 4096)) then raise exception 'Invalid backup'; end if;
  select count(*) into recent from public.chat_key_events where user_id = me and action in ('recovery_key', 'passphrase') and created_at > now() - interval '1 hour';
  if recent >= 10 then raise exception 'Too many changes. Please wait a while.'; end if;
  update public.chat_key_backups set backup = coalesce(p_backup, backup), recovery = coalesce(p_recovery, recovery), updated_at = now() where user_id = me;
  if not found then raise exception 'Turn on secure chat first'; end if;
  if p_backup is not null then insert into public.chat_key_events (user_id, action) values (me, 'passphrase'); end if;
  if p_recovery is not null then insert into public.chat_key_events (user_id, action) values (me, 'recovery_key'); end if;
  perform public.notify(me, 'security', null, 'profile', me, 'cb:' || gen_random_uuid());
end $$;

-- "This wasn't me": any signed-in device of the account can stop a recovery in progress.
create or replace function public.cancel_recovery_request(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.chat_recovery_requests set status = 'cancelled', updated_at = now() where id = p_id and user_id = auth.uid() and status = 'waiting';
  if not found then raise exception 'There is nothing to cancel'; end if;
  insert into public.chat_key_events (user_id, action) values (auth.uid(), 'recovery_cancelled');
end $$;

-- Service role only (the recovery Edge Function): records an event and alerts the member.
create or replace function public.chat_security_event(p_user uuid, p_action text, p_detail jsonb default '{}'::jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.chat_key_events (user_id, action, detail) values (p_user, p_action, coalesce(p_detail, '{}'::jsonb));
  if p_action in ('escrow_on', 'escrow_off', 'recovery_requested', 'recovery_completed') then
    perform public.notify(p_user, 'security', null, 'profile', p_user, 'cs:' || gen_random_uuid());
  end if;
end $$;

-- Expire stale requests whenever someone looks (no scheduler needed).
create or replace function public.expire_recovery_requests() returns void
language sql security definer set search_path = '' as $$
  update public.chat_recovery_requests set status = 'expired', updated_at = now() where status = 'waiting' and expires_at < now();
$$;

-- ---------------------------------------------------------------- end-to-end encrypted groups
alter table public.conversations add column if not exists key_epoch integer not null default 0 check (key_epoch >= 0);

create table if not exists public.conversation_keys (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  epoch integer not null check (epoch >= 1),
  wrapped text not null check (char_length(wrapped) between 40 and 400),
  wrapped_by uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (conversation_id, user_id, epoch)
);

alter table public.conversation_keys enable row level security;

drop policy if exists conversation_keys_read on public.conversation_keys;

create policy conversation_keys_read on public.conversation_keys for select to authenticated using (user_id = auth.uid());
