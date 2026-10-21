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

create or replace function public.start_call(p_conversation uuid, p_kind text) returns jsonb
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
  insert into public.calls (conversation_id, caller, callee, kind) values (p_conversation, me, other, p_kind) returning * into c;
  return jsonb_build_object('id', c.id, 'room', c.room, 'kind', c.kind);
end $$;
