revoke execute on function public.start_call(uuid, text, boolean) from public, anon;

grant execute on function public.start_call(uuid, text, boolean) to authenticated;

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
