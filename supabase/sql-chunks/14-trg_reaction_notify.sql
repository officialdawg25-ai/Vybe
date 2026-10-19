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

-- Capacity is enforced where concurrent writers meet: the database.
create or replace function public.trg_rsvp_capacity() returns trigger
language plpgsql security definer set search_path = '' as $$
declare cap integer; taken integer;
begin
  new.updated_at := now();
  if new.status = 'going' then
    select capacity into cap from public.events where id = new.event_id for update;
    if cap is not null then
      select count(*) into taken from public.event_rsvps
        where event_id = new.event_id and status = 'going' and user_id <> new.user_id;
      if taken >= cap then raise exception 'event is at capacity' using errcode = 'P0001'; end if;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists rsvp_capacity on public.event_rsvps;

create trigger rsvp_capacity before insert or update of status on public.event_rsvps
  for each row execute function public.trg_rsvp_capacity();
