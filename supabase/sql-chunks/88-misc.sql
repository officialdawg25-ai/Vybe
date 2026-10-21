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
