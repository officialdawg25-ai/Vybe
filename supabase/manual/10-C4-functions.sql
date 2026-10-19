-- Part C4/4: messaging and account functions + execute permissions
-- ----------------------------------------------------------------- RPCs
create or replace function public.start_dm(other uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid(); cid uuid; policy text;
begin
  if me is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  if other = me then raise exception 'cannot message yourself'; end if;
  select dm_policy into policy from public.profiles where id = other;
  if policy is null then raise exception 'user not found'; end if;
  if public.is_blocked(me, other) then raise exception 'messaging unavailable' using errcode = '42501'; end if;
  if policy = 'friends' and not public.are_friends(me, other) then
    raise exception 'this person only accepts messages from friends' using errcode = '42501';
  end if;
  select c.id into cid from public.conversations c
    where not c.is_group
      and exists (select 1 from public.conversation_members m where m.conversation_id = c.id and m.user_id = me)
      and exists (select 1 from public.conversation_members m where m.conversation_id = c.id and m.user_id = other)
    limit 1;
  if cid is null then
    insert into public.conversations (created_by) values (me) returning id into cid;
    insert into public.conversation_members (conversation_id, user_id) values (cid, me), (cid, other);
  end if;
  return cid;
end $$;

create or replace function public.start_group(title text, members uuid[]) returns uuid
language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid(); cid uuid; m uuid;
begin
  if me is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  if cardinality(members) is null or cardinality(members) > 49 then raise exception 'invalid group size'; end if;
  insert into public.conversations (is_group, title, created_by) values (true, left(title, 80), me) returning id into cid;
  insert into public.conversation_members (conversation_id, user_id) values (cid, me);
  foreach m in array members loop
    -- Only friends can be added to a group; silently skip anyone else.
    if m <> me and public.are_friends(me, m) and not public.is_blocked(me, m) then
      insert into public.conversation_members (conversation_id, user_id) values (cid, m) on conflict do nothing;
    end if;
  end loop;
  return cid;
end $$;

create or replace function public.delete_my_account() returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  delete from auth.users where id = auth.uid();
end $$;

revoke execute on function public.start_dm(uuid), public.start_group(text, uuid[]), public.delete_my_account() from public, anon;
grant execute on function public.start_dm(uuid), public.start_group(text, uuid[]), public.delete_my_account() to authenticated;

-- Staff role helper must not be callable by anon.
revoke execute on function public.is_staff() from public, anon;
grant execute on function public.is_staff() to authenticated;
