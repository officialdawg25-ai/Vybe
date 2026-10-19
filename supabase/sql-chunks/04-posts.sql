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
