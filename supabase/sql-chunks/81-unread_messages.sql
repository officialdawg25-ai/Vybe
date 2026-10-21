-- ---------------------------------------------------------------- unread message count (header badge)
-- Capped at 100 so the badge stays cheap however much mail has piled up.
create or replace function public.unread_messages() returns integer
language sql stable security definer set search_path = '' as $$
  select least(count(*), 100)::integer from (
    select 1 from public.conversation_members cm
    join public.messages m on m.conversation_id = cm.conversation_id and m.created_at > cm.last_read_at and m.sender <> cm.user_id and m.deleted_at is null
    where cm.user_id = auth.uid()
    limit 100
  ) x;
$$;

revoke execute on function public.unread_messages() from public, anon;

grant execute on function public.unread_messages() to authenticated;

-- ---------------------------------------------------------------- 1:1 voice and video calls (media runs over LiveKit)
create table if not exists public.calls (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  caller uuid not null references public.profiles(id) on delete cascade,
  callee uuid not null references public.profiles(id) on delete cascade,
  kind text not null check (kind in ('audio', 'video')),
  status text not null default 'ringing' check (status in ('ringing', 'active', 'declined', 'ended', 'missed', 'cancelled')),
  room text not null unique default ('call-' || replace(gen_random_uuid()::text, '-', '')),
  created_at timestamptz not null default now(),
  answered_at timestamptz,
  ended_at timestamptz,
  check (caller <> callee)
);

create index if not exists calls_callee_idx on public.calls (callee, created_at desc);

create index if not exists calls_caller_idx on public.calls (caller, created_at desc);

alter table public.calls enable row level security;

drop policy if exists calls_read on public.calls;

create policy calls_read on public.calls for select to authenticated using (caller = auth.uid() or callee = auth.uid());

revoke all on public.calls from anon, authenticated;

grant select on public.calls to authenticated;
