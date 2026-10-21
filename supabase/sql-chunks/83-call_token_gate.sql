-- The edge function asks this before minting a LiveKit token: only the two people on a live call, and only while it can still be joined.
create or replace function public.call_token_gate(p_call uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.calls; p public.profiles;
begin
  if auth.uid() is null then raise exception 'Sign in' using errcode = '28000'; end if;
  select * into c from public.calls where id = p_call and (caller = auth.uid() or callee = auth.uid());
  if not found then raise exception 'Call not found'; end if;
  if c.status = 'ringing' and c.created_at < now() - interval '60 seconds' then raise exception 'This call has ended'; end if;
  if c.status not in ('ringing', 'active') then raise exception 'This call has ended'; end if;
  if c.status = 'ringing' and c.callee = auth.uid() then raise exception 'Answer the call first'; end if;
  select * into p from public.profiles where id = auth.uid();
  return jsonb_build_object('room', c.room, 'kind', c.kind, 'name', coalesce(nullif(p.display_name, ''), p.username),
                            'role', case when c.caller = auth.uid() then 'caller' else 'callee' end);
end $$;

revoke execute on function public.start_call(uuid, text), public.respond_call(uuid, boolean), public.end_call(uuid), public.call_token_gate(uuid) from public, anon;

grant execute on function public.start_call(uuid, text), public.respond_call(uuid, boolean), public.end_call(uuid), public.call_token_gate(uuid) to authenticated;

-- Realtime delivery (incoming calls, new messages, notifications). Skipped where the publication does not exist.
do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['calls', 'messages', 'notifications'] loop
      if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;

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
