-- Community creator becomes the owner; private-community joins notify moderators' owner.
create or replace function public.trg_community_owner() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.community_members (community_id, user_id, role, status)
  values (new.id, new.created_by, 'owner', 'active');
  return new;
end $$;

drop trigger if exists community_owner on public.communities;

create trigger community_owner after insert on public.communities
  for each row execute function public.trg_community_owner();

create or replace function public.trg_member_notify() returns trigger
language plpgsql security definer set search_path = '' as $$
declare owner uuid;
begin
  select created_by into owner from public.communities where id = new.community_id;
  perform public.notify(owner, 'community_join', new.user_id, 'community', new.community_id, 'cj:' || new.community_id || ':' || new.user_id);
  return new;
end $$;

drop trigger if exists member_notify on public.community_members;

create trigger member_notify after insert on public.community_members
  for each row when (new.role = 'member') execute function public.trg_member_notify();

-- Basic abuse throttle (per author, sliding window) for posts and messages.
create or replace function public.trg_throttle() returns trigger
language plpgsql security definer set search_path = '' as $$
declare n integer; lim integer := tg_argv[0]::integer; win interval := tg_argv[1]::interval; col text := tg_argv[2];
begin
  execute format('select count(*) from %I.%I where %I = $1 and created_at > now() - $2', tg_table_schema, tg_table_name, col)
    into n using (to_jsonb(new)->>col)::uuid, win;
  if n >= lim then raise exception 'rate limit exceeded' using errcode = 'P0001'; end if;
  return new;
end $$;

drop trigger if exists posts_throttle on public.posts;

create trigger posts_throttle before insert on public.posts
  for each row execute function public.trg_throttle(20, '10 minutes', 'author');

drop trigger if exists messages_throttle on public.messages;

create trigger messages_throttle before insert on public.messages
  for each row execute function public.trg_throttle(60, '1 minute', 'sender');

drop trigger if exists comments_throttle on public.comments;

create trigger comments_throttle before insert on public.comments
  for each row execute function public.trg_throttle(30, '5 minutes', 'author');
