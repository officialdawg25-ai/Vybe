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
