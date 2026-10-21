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
