-- VYBE core schema. Additive only: every object is created with IF NOT EXISTS
-- semantics where practical and nothing here drops or rewrites existing data.
-- Security model: RLS on every table; privileged helpers are SECURITY DEFINER
-- with an empty search_path and fully-qualified names.

-- ---------------------------------------------------------------- profiles
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null,
  display_name text not null default '',
  bio text not null default '' check (char_length(bio) <= 500),
  avatar_path text,
  location text check (char_length(location) <= 120),
  interests text[] not null default '{}' check (cardinality(interests) <= 20),
  dm_policy text not null default 'friends' check (dm_policy in ('friends','everyone')),
  onboarded_at timestamptz,
  created_at timestamptz not null default now(),
  constraint username_format check (username ~ '^[a-z0-9_]{3,30}$'),
  constraint display_name_len check (char_length(display_name) <= 60)
);
create unique index if not exists profiles_username_key on public.profiles (lower(username));
create index if not exists profiles_username_prefix on public.profiles (lower(username) text_pattern_ops);

-- Staff are kept out of any user-writable table so privileges cannot be
-- acquired through profile or auth metadata.
create table if not exists public.staff (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null check (role in ('moderator','admin')),
  created_at timestamptz not null default now()
);

create table if not exists public.blocks (
  blocker uuid not null references public.profiles(id) on delete cascade,
  blocked uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker, blocked),
  check (blocker <> blocked)
);
create index if not exists blocks_blocked_idx on public.blocks (blocked);

-- One social graph: a friendship row is a request until accepted.
create table if not exists public.friendships (
  id uuid primary key default gen_random_uuid(),
  requester uuid not null references public.profiles(id) on delete cascade,
  addressee uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','accepted')),
  created_at timestamptz not null default now(),
  check (requester <> addressee)
);
create unique index if not exists friendships_pair_key
  on public.friendships (least(requester, addressee), greatest(requester, addressee));
create index if not exists friendships_addressee_idx on public.friendships (addressee, status);
create index if not exists friendships_requester_idx on public.friendships (requester, status);

-- -------------------------------------------------------------- helpers
create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.staff where user_id = auth.uid());
$$;

create or replace function public.is_blocked(a uuid, b uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.blocks
    where (blocker = a and blocked = b) or (blocker = b and blocked = a)
  );
$$;

create or replace function public.are_friends(a uuid, b uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.friendships
    where status = 'accepted'
      and ((requester = a and addressee = b) or (requester = b and addressee = a))
  );
$$;

-- ------------------------------------------------------------ communities
create table if not exists public.communities (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 2 and 80),
  description text not null default '' check (char_length(description) <= 1000),
  rules text not null default '' check (char_length(rules) <= 2000),
  cover_path text,
  topics text[] not null default '{}' check (cardinality(topics) <= 10),
  visibility text not null default 'public' check (visibility in ('public','private')),
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now()
);
create index if not exists communities_created_idx on public.communities (created_at desc);

create table if not exists public.community_members (
  community_id uuid not null references public.communities(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null default 'member' check (role in ('owner','admin','moderator','member')),
  status text not null default 'active' check (status in ('active','pending')),
  created_at timestamptz not null default now(),
  primary key (community_id, user_id)
);
create index if not exists community_members_user_idx on public.community_members (user_id);

create or replace function public.community_role(cid uuid) returns text
language sql stable security definer set search_path = '' as $$
  select role from public.community_members
  where community_id = cid and user_id = auth.uid() and status = 'active';
$$;

create or replace function public.is_community_member(cid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.community_role(cid) is not null;
$$;

create or replace function public.can_moderate_community(cid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(public.community_role(cid) in ('owner','admin','moderator'), false);
$$;

create or replace function public.community_is_public(cid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.communities where id = cid and visibility = 'public');
$$;

-- ---------------------------------------------------------- events/plans
create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  host uuid not null references public.profiles(id) on delete cascade,
  title text not null check (char_length(title) between 2 and 120),
  description text not null default '' check (char_length(description) <= 4000),
  cover_path text,
  starts_at timestamptz not null,
  ends_at timestamptz,
  timezone text not null default 'UTC',
  location text check (char_length(location) <= 200),
  visibility text not null default 'public' check (visibility in ('public','friends','invite')),
  capacity integer check (capacity is null or capacity > 0),
  community_id uuid references public.communities(id) on delete set null,
  price_cents integer check (price_cents is null or price_cents >= 0),
  currency text check (currency is null or currency ~ '^[A-Z]{3}$'),
  ticket_url text check (ticket_url is null or ticket_url ~* '^https?://'),
  status text not null default 'active' check (status in ('active','cancelled')),
  created_at timestamptz not null default now(),
  check (ends_at is null or ends_at > starts_at)
);
create index if not exists events_starts_idx on public.events (starts_at);
create index if not exists events_host_idx on public.events (host);
create index if not exists events_community_idx on public.events (community_id);

create table if not exists public.event_rsvps (
  event_id uuid not null references public.events(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  status text not null check (status in ('invited','going','maybe','declined')),
  updated_at timestamptz not null default now(),
  primary key (event_id, user_id)
);
create index if not exists event_rsvps_user_idx on public.event_rsvps (user_id, status);

-- Used by the events policy; SECURITY DEFINER avoids policy recursion with rsvps.
create or replace function public.is_invited(eid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.event_rsvps where event_id = eid and user_id = auth.uid());
$$;

-- ----------------------------------------------------------------- posts
create table if not exists public.posts (
  id uuid primary key default gen_random_uuid(),
  author uuid not null references public.profiles(id) on delete cascade,
  body text not null default '' check (char_length(body) <= 5000),
  media_path text,
  media_type text check (media_type in ('image','video')),
  visibility text not null default 'public' check (visibility in ('public','friends','community')),
  community_id uuid references public.communities(id) on delete cascade,
  event_id uuid references public.events(id) on delete set null,
  created_at timestamptz not null default now(),
  edited_at timestamptz,
  check (body <> '' or media_path is not null),
  check ((visibility = 'community') = (community_id is not null)),
  check ((media_path is null) = (media_type is null))
);
create index if not exists posts_created_idx on public.posts (created_at desc, id desc);
create index if not exists posts_author_idx on public.posts (author, created_at desc);
create index if not exists posts_community_idx on public.posts (community_id, created_at desc);

create table if not exists public.comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts(id) on delete cascade,
  author uuid not null references public.profiles(id) on delete cascade,
  parent_id uuid references public.comments(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default now(),
  edited_at timestamptz
);
create index if not exists comments_post_idx on public.comments (post_id, created_at);

create table if not exists public.reactions (
  post_id uuid not null references public.posts(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null default 'like' check (kind in ('like','love','laugh','wow')),
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);

create table if not exists public.saves (
  post_id uuid not null references public.posts(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, post_id)
);

-- ------------------------------------------------------------- messaging
create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  is_group boolean not null default false,
  title text check (char_length(title) <= 80),
  created_by uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.conversation_members (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  last_read_at timestamptz not null default now(),
  muted boolean not null default false,
  joined_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);
create index if not exists conversation_members_user_idx on public.conversation_members (user_id);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  sender uuid not null references public.profiles(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 4000),
  reply_to uuid references public.messages(id) on delete set null,
  client_id uuid,
  created_at timestamptz not null default now(),
  edited_at timestamptz,
  deleted_at timestamptz
);
create index if not exists messages_conv_idx on public.messages (conversation_id, created_at desc);
-- Idempotent sends: a retried send with the same client_id is rejected, not duplicated.
create unique index if not exists messages_client_key on public.messages (sender, client_id) where client_id is not null;

create or replace function public.is_conversation_member(cid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.conversation_members where conversation_id = cid and user_id = auth.uid());
$$;

-- ---------------------------------------------- notifications/safety/audit
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  type text not null check (type in ('friend_request','friend_accepted','reaction','comment','event_invite','rsvp','community_join')),
  actor_id uuid references public.profiles(id) on delete cascade,
  entity_type text,
  entity_id uuid,
  dedupe_key text not null,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, dedupe_key)
);
create index if not exists notifications_user_idx on public.notifications (user_id, created_at desc);

create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),
  reporter uuid not null references public.profiles(id) on delete cascade,
  entity_type text not null check (entity_type in ('profile','post','comment','message','community','event')),
  entity_id uuid not null,
  reason text not null check (char_length(reason) between 3 and 1000),
  status text not null default 'submitted' check (status in ('submitted','reviewing','actioned','dismissed','escalated')),
  created_at timestamptz not null default now(),
  unique (reporter, entity_type, entity_id)
);
create index if not exists reports_status_idx on public.reports (status, created_at);

create table if not exists public.audit_log (
  id bigint generated always as identity primary key,
  actor uuid,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);

-- Posts visibility is evaluated by RLS; this helper is shared by dependants.
create or replace function public.can_view_post(p public.posts) returns boolean
language sql stable security definer set search_path = '' as $$
  select p.author = auth.uid() or (
    not public.is_blocked(auth.uid(), p.author) and (
      p.visibility = 'public'
      or (p.visibility = 'friends' and public.are_friends(auth.uid(), p.author))
      or (p.visibility = 'community' and public.is_community_member(p.community_id))
    )
  );
$$;

create or replace function public.can_view_event(e public.events) returns boolean
language sql stable security definer set search_path = '' as $$
  select e.host = auth.uid() or (
    not public.is_blocked(auth.uid(), e.host) and (
      public.is_invited(e.id)
      or (e.visibility = 'public' and (e.community_id is null or public.community_is_public(e.community_id) or public.is_community_member(e.community_id)))
      or (e.visibility = 'friends' and public.are_friends(auth.uid(), e.host))
    )
  );
$$;

-- ----------------------------------------------------------------- RLS
alter table public.profiles enable row level security;
alter table public.staff enable row level security;
alter table public.blocks enable row level security;
alter table public.friendships enable row level security;
alter table public.communities enable row level security;
alter table public.community_members enable row level security;
alter table public.events enable row level security;
alter table public.event_rsvps enable row level security;
alter table public.posts enable row level security;
alter table public.comments enable row level security;
alter table public.reactions enable row level security;
alter table public.saves enable row level security;
alter table public.conversations enable row level security;
alter table public.conversation_members enable row level security;
alter table public.messages enable row level security;
alter table public.notifications enable row level security;
alter table public.reports enable row level security;
alter table public.audit_log enable row level security;

-- profiles: readable by signed-in users unless blocked; self-service edits only.
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or not public.is_blocked(auth.uid(), id));
create policy profiles_update on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- staff: no client access at all (no policies => denied). Managed with service role / SQL.

create policy blocks_select on public.blocks for select to authenticated using (blocker = auth.uid());
create policy blocks_insert on public.blocks for insert to authenticated with check (blocker = auth.uid());
create policy blocks_delete on public.blocks for delete to authenticated using (blocker = auth.uid());

create policy friendships_select on public.friendships for select to authenticated
  using (requester = auth.uid() or addressee = auth.uid());
create policy friendships_insert on public.friendships for insert to authenticated
  with check (requester = auth.uid() and status = 'pending' and not public.is_blocked(requester, addressee));
create policy friendships_accept on public.friendships for update to authenticated
  using (addressee = auth.uid() and status = 'pending') with check (addressee = auth.uid() and status = 'accepted');
create policy friendships_delete on public.friendships for delete to authenticated
  using (requester = auth.uid() or addressee = auth.uid());

create policy communities_select on public.communities for select to authenticated using (true);
create policy communities_insert on public.communities for insert to authenticated with check (created_by = auth.uid());
create policy communities_update on public.communities for update to authenticated
  using (public.community_role(id) in ('owner','admin')) with check (created_by = (select c.created_by from public.communities c where c.id = communities.id));
create policy communities_delete on public.communities for delete to authenticated using (created_by = auth.uid());

create policy cm_select on public.community_members for select to authenticated
  using (user_id = auth.uid() or public.is_community_member(community_id) or public.community_is_public(community_id));
create policy cm_join on public.community_members for insert to authenticated
  with check (
    user_id = auth.uid() and role = 'member'
    and ((public.community_is_public(community_id) and status = 'active')
      or (not public.community_is_public(community_id) and status = 'pending'))
  );
create policy cm_manage on public.community_members for update to authenticated
  using (public.can_moderate_community(community_id) and role <> 'owner')
  with check (role in ('member','moderator','admin') and (role = 'member' or public.community_role(community_id) in ('owner','admin')));
create policy cm_leave_or_remove on public.community_members for delete to authenticated
  using ((user_id = auth.uid() and role <> 'owner') or (public.can_moderate_community(community_id) and role <> 'owner'));

create policy events_select on public.events for select to authenticated using (public.can_view_event(events));
create policy events_insert on public.events for insert to authenticated
  with check (host = auth.uid() and (community_id is null or public.is_community_member(community_id)));
create policy events_update on public.events for update to authenticated using (host = auth.uid()) with check (host = auth.uid());
create policy events_delete on public.events for delete to authenticated using (host = auth.uid());

create policy rsvps_select on public.event_rsvps for select to authenticated
  using (user_id = auth.uid() or exists (select 1 from public.events e where e.id = event_id));
create policy rsvps_self on public.event_rsvps for insert to authenticated
  with check (
    user_id = auth.uid() and status in ('going','maybe','declined')
    and exists (select 1 from public.events e where e.id = event_id and e.status = 'active')
  );
create policy rsvps_invite on public.event_rsvps for insert to authenticated
  with check (
    status = 'invited' and user_id <> auth.uid()
    and exists (select 1 from public.events e where e.id = event_id and e.host = auth.uid())
    and not public.is_blocked(auth.uid(), user_id)
  );
create policy rsvps_update on public.event_rsvps for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid() and status in ('going','maybe','declined'));
create policy rsvps_delete on public.event_rsvps for delete to authenticated
  using (user_id = auth.uid() or exists (select 1 from public.events e where e.id = event_id and e.host = auth.uid()));

create policy posts_select on public.posts for select to authenticated using (public.can_view_post(posts));
create policy posts_insert on public.posts for insert to authenticated
  with check (
    author = auth.uid()
    and (community_id is null or public.is_community_member(community_id))
    and (media_path is null or media_path like auth.uid()::text || '/%')
  );
create policy posts_update on public.posts for update to authenticated using (author = auth.uid()) with check (author = auth.uid());
create policy posts_delete on public.posts for delete to authenticated
  using (author = auth.uid() or (community_id is not null and public.can_moderate_community(community_id)));

create policy comments_select on public.comments for select to authenticated
  using (exists (select 1 from public.posts p where p.id = post_id));
create policy comments_insert on public.comments for insert to authenticated
  with check (author = auth.uid() and exists (select 1 from public.posts p where p.id = post_id));
create policy comments_update on public.comments for update to authenticated using (author = auth.uid()) with check (author = auth.uid());
create policy comments_delete on public.comments for delete to authenticated
  using (author = auth.uid() or exists (select 1 from public.posts p where p.id = post_id and p.author = auth.uid()));

create policy reactions_select on public.reactions for select to authenticated
  using (exists (select 1 from public.posts p where p.id = post_id));
create policy reactions_insert on public.reactions for insert to authenticated
  with check (user_id = auth.uid() and exists (select 1 from public.posts p where p.id = post_id));
create policy reactions_update on public.reactions for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy reactions_delete on public.reactions for delete to authenticated using (user_id = auth.uid());

create policy saves_select on public.saves for select to authenticated using (user_id = auth.uid());
create policy saves_insert on public.saves for insert to authenticated
  with check (user_id = auth.uid() and exists (select 1 from public.posts p where p.id = post_id));
create policy saves_delete on public.saves for delete to authenticated using (user_id = auth.uid());

-- conversations/members are created only through the RPCs below.
create policy conv_select on public.conversations for select to authenticated using (public.is_conversation_member(id));
create policy cmem_select on public.conversation_members for select to authenticated using (public.is_conversation_member(conversation_id));
create policy cmem_update_self on public.conversation_members for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy cmem_leave on public.conversation_members for delete to authenticated using (user_id = auth.uid());

create policy messages_select on public.messages for select to authenticated using (public.is_conversation_member(conversation_id));
create policy messages_insert on public.messages for insert to authenticated
  with check (sender = auth.uid() and public.is_conversation_member(conversation_id));
create policy messages_update on public.messages for update to authenticated using (sender = auth.uid()) with check (sender = auth.uid());

create policy notifications_select on public.notifications for select to authenticated using (user_id = auth.uid());
create policy notifications_update on public.notifications for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy notifications_delete on public.notifications for delete to authenticated using (user_id = auth.uid());

create policy reports_insert on public.reports for insert to authenticated with check (reporter = auth.uid() and status = 'submitted');
create policy reports_select on public.reports for select to authenticated using (reporter = auth.uid() or public.is_staff());
create policy reports_staff_update on public.reports for update to authenticated using (public.is_staff()) with check (public.is_staff());

create policy audit_staff_select on public.audit_log for select to authenticated using (public.is_staff());

-- Column-level grants: clients cannot rewrite ownership, authorship or history.
revoke all on all tables in schema public from anon, authenticated;
grant select on public.profiles, public.blocks, public.friendships, public.communities, public.community_members,
  public.events, public.event_rsvps, public.posts, public.comments, public.reactions, public.saves,
  public.conversations, public.conversation_members, public.messages, public.notifications,
  public.reports, public.audit_log to authenticated;
grant update (display_name, bio, avatar_path, location, interests, dm_policy, onboarded_at) on public.profiles to authenticated;
grant insert, delete on public.blocks to authenticated;
grant insert, delete on public.friendships to authenticated;
grant update (status) on public.friendships to authenticated;
grant insert, delete on public.communities to authenticated;
grant update (name, description, rules, cover_path, topics, visibility) on public.communities to authenticated;
grant insert, delete on public.community_members to authenticated;
grant update (role, status) on public.community_members to authenticated;
grant insert, delete on public.events to authenticated;
grant update (title, description, cover_path, starts_at, ends_at, timezone, location, visibility, capacity,
  price_cents, currency, ticket_url, status) on public.events to authenticated;
grant insert, delete on public.event_rsvps to authenticated;
grant update (status) on public.event_rsvps to authenticated;
grant insert, delete on public.posts to authenticated;
grant update (body, visibility) on public.posts to authenticated;
grant insert, delete on public.comments to authenticated;
grant update (body) on public.comments to authenticated;
grant insert, update (kind), delete on public.reactions to authenticated;
grant insert, delete on public.saves to authenticated;
grant update (last_read_at, muted), delete on public.conversation_members to authenticated;
grant insert on public.messages to authenticated;
grant update (body, deleted_at) on public.messages to authenticated;
grant update (read_at), delete on public.notifications to authenticated;
grant insert on public.reports to authenticated;
grant update (status) on public.reports to authenticated;

-- ----------------------------------------------------------- triggers
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
create trigger rsvp_capacity before insert or update of status on public.event_rsvps
  for each row execute function public.trg_rsvp_capacity();

-- Community creator becomes the owner; private-community joins notify moderators' owner.
create or replace function public.trg_community_owner() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.community_members (community_id, user_id, role, status)
  values (new.id, new.created_by, 'owner', 'active');
  return new;
end $$;
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
create trigger posts_throttle before insert on public.posts
  for each row execute function public.trg_throttle(20, '10 minutes', 'author');
create trigger messages_throttle before insert on public.messages
  for each row execute function public.trg_throttle(60, '1 minute', 'sender');
create trigger comments_throttle before insert on public.comments
  for each row execute function public.trg_throttle(30, '5 minutes', 'author');

create or replace function public.trg_report_audit() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status <> old.status then
    insert into public.audit_log (actor, action, entity_type, entity_id, detail)
    values (auth.uid(), 'report.' || new.status, 'report', new.id, jsonb_build_object('from', old.status));
  end if;
  return new;
end $$;
create trigger report_audit after update of status on public.reports
  for each row execute function public.trg_report_audit();

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
