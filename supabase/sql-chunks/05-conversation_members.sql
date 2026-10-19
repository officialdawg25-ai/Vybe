create table if not exists public.conversation_members (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  last_read_at timestamptz not null default now(),
  muted boolean not null default false,
  joined_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

create index if not exists conversation_members_user_idx on public.conversation_members (user_id);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  sender uuid not null references public.profiles(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 4000),
  reply_to uuid references public.messages(id) on delete set null,
  client_id uuid,
  created_at timestamptz not null default now(),
  edited_at timestamptz,
  deleted_at timestamptz
);

create index if not exists messages_conv_idx on public.messages (conversation_id, created_at desc);

-- Idempotent sends: a retried send with the same client_id is rejected, not duplicated.
create unique index if not exists messages_client_key on public.messages (sender, client_id) where client_id is not null;

create or replace function public.is_conversation_member(cid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.conversation_members where conversation_id = cid and user_id = auth.uid());
$$;

-- ---------------------------------------------- notifications/safety/audit
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  type text not null check (type in ('friend_request','friend_accepted','reaction','comment','event_invite','rsvp','community_join')),
  actor_id uuid references public.profiles(id) on delete cascade,
  entity_type text,
  entity_id uuid,
  dedupe_key text not null,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, dedupe_key)
);

create index if not exists notifications_user_idx on public.notifications (user_id, created_at desc);

create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),
  reporter uuid not null references public.profiles(id) on delete cascade,
  entity_type text not null check (entity_type in ('profile','post','comment','message','community','event')),
  entity_id uuid not null,
  reason text not null check (char_length(reason) between 3 and 1000),
  status text not null default 'submitted' check (status in ('submitted','reviewing','actioned','dismissed','escalated')),
  created_at timestamptz not null default now(),
  unique (reporter, entity_type, entity_id)
);

create index if not exists reports_status_idx on public.reports (status, created_at);
