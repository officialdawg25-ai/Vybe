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

create or replace function public.trg_friendship_lock() returns trigger
language plpgsql as $$
begin
  if new.requester <> old.requester or new.addressee <> old.addressee then
    raise exception 'friendship parties are immutable';
  end if;
  return new;
end $$;

drop trigger if exists friendship_lock on public.friendships;

create trigger friendship_lock before update on public.friendships
  for each row execute function public.trg_friendship_lock();

create or replace function public.trg_comment_notify() returns trigger
language plpgsql security definer set search_path = '' as $$
declare owner uuid;
begin
  select author into owner from public.posts where id = new.post_id;
  perform public.notify(owner, 'comment', new.author, 'post', new.post_id, 'c:' || new.id);
  return new;
end $$;

drop trigger if exists comment_notify on public.comments;

create trigger comment_notify after insert on public.comments
  for each row execute function public.trg_comment_notify();
