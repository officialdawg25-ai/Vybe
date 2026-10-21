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
