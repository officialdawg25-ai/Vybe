-- Run 04-plans.sql (storage/platform/brand hero set), in filename order. Re-runnable.
alter table public.plans enable row level security;

alter table public.subscriptions enable row level security;

alter table public.provider_events enable row level security;

drop policy if exists plans_select on public.plans;

create policy plans_select on public.plans for select to authenticated using (true);

drop policy if exists subs_select on public.subscriptions;

create policy subs_select on public.subscriptions for select to authenticated
  using (user_id = auth.uid() or public.org_role(organization_id) in ('owner','admin'));

revoke all on public.plans, public.subscriptions, public.provider_events from anon, authenticated;

grant select on public.plans, public.subscriptions to authenticated;

-- Server-side check for gated capabilities; never trust a client claim.
create or replace function public.has_feature(feature text, org uuid default null) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.subscriptions s join public.plans p on p.id = s.plan_id
    where s.status in ('active','trialing') and (s.current_period_end is null or s.current_period_end > now())
      and feature = any (p.features)
      and ((org is null and s.user_id = auth.uid())
        or (org is not null and s.organization_id = org and public.org_role(org) in ('owner','admin')))
  );
$$;

-- --------------------------------------------------------- live scheduling
-- Streaming itself is provider-hosted (LiveKit); this table is the app-side record.
-- Transitions to 'live'/'ended' are performed only by a server holding provider credentials.
create table if not exists public.live_streams (
  id uuid primary key default gen_random_uuid(),
  host uuid not null references public.profiles(id) on delete cascade,
  organization_id uuid references public.organizations(id) on delete set null,
  event_id uuid references public.events(id) on delete set null,
  title text not null check (char_length(title) between 2 and 120),
  status text not null default 'scheduled' check (status in ('scheduled','live','ended','cancelled')),
  visibility text not null default 'public' check (visibility in ('public','friends')),
  scheduled_for timestamptz,
  provider text not null default 'livekit',
  room text not null default gen_random_uuid()::text,
  recording_consent boolean not null default false,
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  unique (room)
);

create index if not exists live_streams_status_idx on public.live_streams (status, scheduled_for);

alter table public.live_streams enable row level security;

drop policy if exists live_select on public.live_streams;

create policy live_select on public.live_streams for select to authenticated
  using (host = auth.uid() or (not public.is_blocked(auth.uid(), host)
    and (visibility = 'public' or (visibility = 'friends' and public.are_friends(auth.uid(), host)))));

drop policy if exists live_insert on public.live_streams;

create policy live_insert on public.live_streams for insert to authenticated
  with check (host = auth.uid() and status = 'scheduled'
    and (organization_id is null or public.org_role(organization_id) in ('owner','admin','editor')));

drop policy if exists live_update on public.live_streams;
