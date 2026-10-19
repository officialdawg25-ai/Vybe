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
