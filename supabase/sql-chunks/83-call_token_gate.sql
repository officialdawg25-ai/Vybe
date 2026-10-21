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
