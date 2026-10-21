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

create or replace function public.respond_call(p_call uuid, p_accept boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare c public.calls;
begin
  select * into c from public.calls where id = p_call and callee = auth.uid() for update;
  if not found then raise exception 'Call not found'; end if;
  if c.status <> 'ringing' or c.created_at < now() - interval '60 seconds' then
    update public.calls set status = 'missed', ended_at = now() where id = c.id and status = 'ringing';
    raise exception 'This call has ended';
  end if;
  if p_accept then update public.calls set status = 'active', answered_at = now() where id = c.id;
  else update public.calls set status = 'declined', ended_at = now() where id = c.id; end if;
end $$;

create or replace function public.end_call(p_call uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare c public.calls;
begin
  select * into c from public.calls where id = p_call and (caller = auth.uid() or callee = auth.uid()) for update;
  if not found then raise exception 'Call not found'; end if;
  if c.status = 'ringing' then
    update public.calls set status = case when c.caller = auth.uid() then 'cancelled' else 'declined' end, ended_at = now() where id = c.id;
  elsif c.status = 'active' then
    update public.calls set status = 'ended', ended_at = now() where id = c.id;
  end if;
end $$;
