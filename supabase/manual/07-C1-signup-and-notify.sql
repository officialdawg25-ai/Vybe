-- Part C1/4: sign-up profile trigger, notify helper, friendship notifications
-- Profile creation on signup. Falls back to a generated username on collision.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  wanted text := lower(coalesce(new.raw_user_meta_data->>'username', ''));
  shown text := left(coalesce(nullif(new.raw_user_meta_data->>'display_name', ''), split_part(coalesce(new.email, ''), '@', 1)), 60);
begin
  if wanted !~ '^[a-z0-9_]{3,30}$' then
    wanted := 'user_' || substr(replace(new.id::text, '-', ''), 1, 10);
  end if;
  begin
    insert into public.profiles (id, username, display_name) values (new.id, wanted, shown);
  exception when unique_violation then
    insert into public.profiles (id, username, display_name)
    values (new.id, 'user_' || substr(replace(new.id::text, '-', ''), 1, 10), shown);
  end;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.notify(uid uuid, t text, actor uuid, etype text, eid uuid, dkey text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if uid is null or uid = actor then return; end if;
  insert into public.notifications (user_id, type, actor_id, entity_type, entity_id, dedupe_key)
  values (uid, t, actor, etype, eid, dkey)
  on conflict (user_id, dedupe_key) do nothing;
end $$;
revoke execute on function public.notify(uuid, text, uuid, text, uuid, text) from public, anon, authenticated;

create or replace function public.trg_friendship_notify() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    perform public.notify(new.addressee, 'friend_request', new.requester, 'profile', new.requester, 'fr:' || new.id);
  elsif new.status = 'accepted' and old.status = 'pending' then
    perform public.notify(new.requester, 'friend_accepted', new.addressee, 'profile', new.addressee, 'fa:' || new.id);
  end if;
  return new;
end $$;
drop trigger if exists friendship_notify on public.friendships;
create trigger friendship_notify after insert or update of status on public.friendships
  for each row execute function public.trg_friendship_notify();
