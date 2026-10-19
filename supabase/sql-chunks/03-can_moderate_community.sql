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
