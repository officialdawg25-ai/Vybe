-- Chat security hardening, key recovery and end-to-end encrypted GROUP chats. Additive and re-runnable.
--   * Keys can no longer be written straight to the tables: every change goes through audited, rate-limited functions that also alert the owner.
--   * Recovery: a one-time recovery key (stored only as a wrapped backup) and OPT-IN VYBE-assisted recovery (escrow) that is released only after
--     a waiting period, a password check and alerts, and can be cancelled from any device.
--   * Groups: each group has a key per "epoch", delivered to every member wrapped for their own public key. The server cannot unwrap it.

-- ---------------------------------------------------------------- notification type for security alerts
alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check check (type in
  ('friend_request', 'friend_accepted', 'reaction', 'comment', 'event_invite', 'rsvp', 'community_join', 'new_event', 'event_update', 'event_cancelled', 'live_started',
   'post_tag', 'memory_reaction', 'memory_reply', 'verified', 'security'));

-- ---------------------------------------------------------------- audit trail of key and recovery activity (the member can read their own)
create table if not exists public.chat_key_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  action text not null check (action in ('create', 'rotate', 'recovery_key', 'passphrase', 'escrow_on', 'escrow_off', 'recovery_requested', 'recovery_cancelled', 'recovery_completed', 'recovery_failed')),
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists chat_key_events_user_idx on public.chat_key_events (user_id, created_at desc);
alter table public.chat_key_events enable row level security;
drop policy if exists chat_key_events_own on public.chat_key_events;
create policy chat_key_events_own on public.chat_key_events for select to authenticated using (user_id = auth.uid());
revoke all on public.chat_key_events from anon, authenticated;
grant select on public.chat_key_events to authenticated;

-- ---------------------------------------------------------------- backups: passphrase backup, recovery-key backup, escrow flag
alter table public.chat_key_backups add column if not exists recovery jsonb check (recovery is null or (jsonb_typeof(recovery) = 'object' and pg_column_size(recovery) < 4096));
alter table public.chat_key_backups add column if not exists escrow boolean not null default false;

-- VYBE-assisted recovery: the wrapped key lives in a table NO browser role can read; only the recovery Edge Function (service role) touches it.
create table if not exists public.chat_key_escrow (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  blob text not null check (char_length(blob) between 40 and 2000),
  created_at timestamptz not null default now()
);
alter table public.chat_key_escrow enable row level security;
revoke all on public.chat_key_escrow from anon, authenticated;

create table if not exists public.chat_recovery_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'waiting' check (status in ('waiting', 'completed', 'cancelled', 'expired')),
  created_at timestamptz not null default now(),
  ready_at timestamptz not null,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now(),
  ip_hash text
);
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
drop policy if exists conversation_keys_insert on public.conversation_keys;
create policy conversation_keys_insert on public.conversation_keys for insert to authenticated with check (
  wrapped_by = auth.uid()
  and exists (select 1 from public.conversation_members m where m.conversation_id = conversation_keys.conversation_id and m.user_id = auth.uid())
  and exists (select 1 from public.conversation_members t where t.conversation_id = conversation_keys.conversation_id and t.user_id = conversation_keys.user_id)
  and epoch <= (select c.key_epoch from public.conversations c where c.id = conversation_keys.conversation_id));
-- A member can drop their own row (e.g. a corrupted one) so that a member who holds the key can deliver it again.
drop policy if exists conversation_keys_delete on public.conversation_keys;
create policy conversation_keys_delete on public.conversation_keys for delete to authenticated using (user_id = auth.uid());
revoke all on public.conversation_keys from anon, authenticated;
grant select, insert, delete on public.conversation_keys to authenticated;

-- Turns encryption on for a group. Returns the current epoch and whether THIS call started it (only the starter makes and delivers the key).
-- If a start was abandoned before anyone received the key, the next call starts a fresh epoch, so a group can never be stuck without a key.
create or replace function public.start_group_encryption(p_conversation uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare e integer; made boolean := false;
begin
  if auth.uid() is null then raise exception 'Sign in' using errcode = '28000'; end if;
  if not public.is_conversation_member(p_conversation) then raise exception 'You are not in this conversation'; end if;
  if not exists (select 1 from public.conversations where id = p_conversation and is_group) then raise exception 'Only group chats use group keys'; end if;
  select key_epoch into e from public.conversations where id = p_conversation for update;
  if e = 0 or not exists (select 1 from public.conversation_keys where conversation_id = p_conversation and epoch = e) then
    e := e + 1; made := true;
    update public.conversations set key_epoch = e where id = p_conversation;
    insert into public.chat_key_events (user_id, action, detail) values (auth.uid(), 'create', jsonb_build_object('group', p_conversation, 'epoch', e));
  end if;
  return jsonb_build_object('epoch', e, 'created', made);
end $$;

-- Who still needs the key for this epoch: members with a published key and no delivered copy yet.
create or replace function public.group_key_status(p_conversation uuid, p_epoch integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Sign in' using errcode = '28000'; end if;
  if not public.is_conversation_member(p_conversation) then raise exception 'You are not in this conversation'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('user_id', m.user_id, 'public_key', k.public_key))
    from public.conversation_members m join public.chat_keys k on k.user_id = m.user_id
    where m.conversation_id = p_conversation
      and not exists (select 1 from public.conversation_keys ck where ck.conversation_id = p_conversation and ck.user_id = m.user_id and ck.epoch = p_epoch)), '[]'::jsonb);
end $$;

-- Encrypted chats cannot be downgraded: an encrypted group only accepts encrypted messages, and encrypted messages never carry plain attachments.
alter table public.messages add column if not exists key_epoch integer check (key_epoch is null or key_epoch >= 1);
create or replace function public.trg_message_encryption() returns trigger
language plpgsql security definer set search_path = '' as $$
declare ce integer;
begin
  select key_epoch into ce from public.conversations where id = new.conversation_id;
  if new.e2ee and (new.media_path is not null or new.audio_path is not null) then raise exception 'Attachments in an encrypted chat must be encrypted'; end if;
  if coalesce(ce, 0) > 0 then
    if not new.e2ee then raise exception 'This chat is end-to-end encrypted. Turn on secure chat to take part.'; end if;
    if new.key_epoch is null or new.key_epoch > ce then raise exception 'Invalid group key'; end if;
  elsif new.key_epoch is not null then
    raise exception 'Invalid group key';
  end if;
  return new;
end $$;
drop trigger if exists message_encryption on public.messages;
create trigger message_encryption before insert on public.messages for each row execute function public.trg_message_encryption();

revoke execute on function public.publish_chat_key(text, jsonb, jsonb), public.update_chat_backups(jsonb, jsonb), public.cancel_recovery_request(uuid),
  public.start_group_encryption(uuid), public.group_key_status(uuid, integer), public.expire_recovery_requests() from public, anon;
grant execute on function public.publish_chat_key(text, jsonb, jsonb), public.update_chat_backups(jsonb, jsonb), public.cancel_recovery_request(uuid),
  public.start_group_encryption(uuid), public.group_key_status(uuid, integer), public.expire_recovery_requests() to authenticated;
revoke execute on function public.chat_security_event(uuid, text, jsonb) from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.chat_security_event(uuid, text, jsonb) to service_role;
    grant select, insert, update, delete on public.chat_key_escrow, public.chat_recovery_requests, public.chat_key_events, public.chat_key_backups, public.chat_keys to service_role;
  end if;
end $$;
