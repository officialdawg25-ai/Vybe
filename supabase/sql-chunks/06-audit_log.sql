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
