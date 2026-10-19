-- VYBE platform layer: notification preferences, organizations, entitlements,
-- live-stream scheduling, and least-privilege staff moderation. Additive only.

-- ------------------------------------------------- notification preferences
alter table public.profiles add column if not exists notif_prefs jsonb not null default '{}'::jsonb;

grant update (notif_prefs) on public.profiles to authenticated;

-- Opt-out per notification type; absent key = enabled. Security-relevant types would bypass this (none exist yet).
create or replace function public.notify(uid uuid, t text, actor uuid, etype text, eid uuid, dkey text) returns void
language plpgsql security definer set search_path = '' as $$
declare allowed boolean;
begin
  if uid is null or uid = actor then return; end if;
  select coalesce((notif_prefs ->> t)::boolean, true) into allowed from public.profiles where id = uid;
  if allowed is distinct from true then return; end if;
  insert into public.notifications (user_id, type, actor_id, entity_type, entity_id, dedupe_key)
  values (uid, t, actor, etype, eid, dkey)
  on conflict (user_id, dedupe_key) do nothing;
end $$;

-- ------------------------------------------------------------ organizations
-- An organization is a separate identity from its members. Membership grants
-- publishing rights for the organization only, never access to members' private data.
create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 2 and 80),
  slug text not null check (slug ~ '^[a-z0-9-]{3,40}$'),
  kind text not null check (kind in ('organizer','venue','business','creator','brand')),
  description text not null default '' check (char_length(description) <= 1000),
  avatar_path text,
  verified_at timestamptz,            -- set by staff via service role only
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now()
);

create unique index if not exists organizations_slug_key on public.organizations (lower(slug));

create table if not exists public.organization_members (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null check (role in ('owner','admin','editor')),
  status text not null default 'invited' check (status in ('invited','active')),
  created_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);

create index if not exists organization_members_user_idx on public.organization_members (user_id);

create or replace function public.org_role(oid uuid) returns text
language sql stable security definer set search_path = '' as $$
  select role from public.organization_members
  where organization_id = oid and user_id = auth.uid() and status = 'active';
$$;

alter table public.events add column if not exists organization_id uuid references public.organizations(id) on delete set null;

create index if not exists events_org_idx on public.events (organization_id);

alter table public.organizations enable row level security;
