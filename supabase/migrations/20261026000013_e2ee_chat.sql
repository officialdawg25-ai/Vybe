-- End-to-end encrypted one-to-one chat. The server only ever stores public keys, passphrase-encrypted key backups and ciphertext:
--   * chat_keys           each member's PUBLIC key (ECDH P-256). Readable by the member and by people they share a conversation with.
--   * chat_key_backups    the member's PRIVATE key, already encrypted in the browser with their chat passphrase. Readable only by them.
--   * messages.e2ee       the body is ciphertext ("e2ee1.<iv>.<data>"); text, file keys, names and types are inside it. Additive and re-runnable.

create table if not exists public.chat_keys (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  public_key text not null check (char_length(public_key) between 80 and 200 and public_key ~ '^[A-Za-z0-9+/]+=*$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.chat_keys enable row level security;
drop policy if exists chat_keys_read on public.chat_keys;
create policy chat_keys_read on public.chat_keys for select to authenticated using (
  user_id = auth.uid()
  or exists (select 1 from public.conversation_members a join public.conversation_members b on b.conversation_id = a.conversation_id
             where a.user_id = auth.uid() and b.user_id = chat_keys.user_id));
drop policy if exists chat_keys_insert on public.chat_keys;
create policy chat_keys_insert on public.chat_keys for insert to authenticated with check (user_id = auth.uid());
drop policy if exists chat_keys_update on public.chat_keys;
create policy chat_keys_update on public.chat_keys for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
revoke all on public.chat_keys from anon, authenticated;
grant select, insert on public.chat_keys to authenticated;
grant update (public_key, updated_at) on public.chat_keys to authenticated;

create table if not exists public.chat_key_backups (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  backup jsonb not null check (jsonb_typeof(backup) = 'object' and pg_column_size(backup) < 4096),
  updated_at timestamptz not null default now()
);
alter table public.chat_key_backups enable row level security;
drop policy if exists chat_key_backups_own on public.chat_key_backups;
create policy chat_key_backups_own on public.chat_key_backups for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
revoke all on public.chat_key_backups from anon, authenticated;
grant select, insert, update on public.chat_key_backups to authenticated;

alter table public.messages add column if not exists e2ee boolean not null default false;
alter table public.messages drop constraint if exists messages_body_len;
alter table public.messages add constraint messages_body_len check (char_length(body) <= case when e2ee then 12000 else 4000 end);
alter table public.messages drop constraint if exists messages_e2ee_shape;
-- An encrypted message always carries ciphertext (until the sender deletes it, which blanks the body).
alter table public.messages add constraint messages_e2ee_shape check (not e2ee or body like 'e2ee1.%' or deleted_at is not null);

-- ---------------------------------------------------------------- end-to-end encrypted calls
-- The caller says whether media is end-to-end encrypted (both phones hold keys and the browser supports it). The callee reads this
-- before answering, so both sides always agree on whether to encrypt.
alter table public.calls add column if not exists encrypted boolean not null default false;
drop function if exists public.start_call(uuid, text);
create or replace function public.start_call(p_conversation uuid, p_kind text, p_encrypted boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid(); other uuid; c public.calls; recent integer;
begin
  if me is null then raise exception 'Sign in' using errcode = '28000'; end if;
  if p_kind not in ('audio', 'video') then raise exception 'Choose a voice or video call'; end if;
  if not public.is_conversation_member(p_conversation) then raise exception 'You are not in this conversation'; end if;
  if exists (select 1 from public.conversations where id = p_conversation and is_group) then raise exception 'Calls are for one-to-one chats'; end if;
  select user_id into other from public.conversation_members where conversation_id = p_conversation and user_id <> me limit 1;
  if other is null then raise exception 'Nobody to call'; end if;
  if public.is_blocked(me, other) then raise exception 'You cannot call this person'; end if;
  select count(*) into recent from public.calls where caller = me and created_at > now() - interval '1 minute';
  if recent >= 6 then raise exception 'Too many calls. Please wait a moment.'; end if;
  update public.calls set status = 'missed', ended_at = now() where status = 'ringing' and created_at < now() - interval '60 seconds' and (caller = me or callee = other);
  update public.calls set status = 'cancelled', ended_at = now() where status = 'ringing' and caller = me;
  if exists (select 1 from public.calls where status in ('ringing', 'active') and (callee = other or caller = other) and coalesce(answered_at, created_at) > now() - interval '6 hours') then
    raise exception 'They are on another call';
  end if;
  insert into public.calls (conversation_id, caller, callee, kind, encrypted) values (p_conversation, me, other, p_kind, coalesce(p_encrypted, false)) returning * into c;
  return jsonb_build_object('id', c.id, 'room', c.room, 'kind', c.kind, 'encrypted', c.encrypted);
end $$;
revoke execute on function public.start_call(uuid, text, boolean) from public, anon;
grant execute on function public.start_call(uuid, text, boolean) to authenticated;
