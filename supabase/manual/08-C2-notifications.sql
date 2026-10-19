-- Part C2/4: friendship lock, comment/reaction/RSVP notifications
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

create or replace function public.trg_reaction_notify() returns trigger
language plpgsql security definer set search_path = '' as $$
declare owner uuid;
begin
  select author into owner from public.posts where id = new.post_id;
  perform public.notify(owner, 'reaction', new.user_id, 'post', new.post_id, 'r:' || new.post_id || ':' || new.user_id);
  return new;
end $$;
drop trigger if exists reaction_notify on public.reactions;
create trigger reaction_notify after insert on public.reactions
  for each row execute function public.trg_reaction_notify();

create or replace function public.trg_rsvp_notify() returns trigger
language plpgsql security definer set search_path = '' as $$
declare h uuid;
begin
  select host into h from public.events where id = new.event_id;
  if new.status = 'invited' then
    perform public.notify(new.user_id, 'event_invite', h, 'event', new.event_id, 'ei:' || new.event_id);
  elsif new.status = 'going' then
    perform public.notify(h, 'rsvp', new.user_id, 'event', new.event_id, 'rs:' || new.event_id || ':' || new.user_id);
  end if;
  return new;
end $$;
drop trigger if exists rsvp_notify on public.event_rsvps;
create trigger rsvp_notify after insert or update of status on public.event_rsvps
  for each row execute function public.trg_rsvp_notify();
