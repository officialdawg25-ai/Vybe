-- Events may be hosted on behalf of an organization the user actively belongs to.
drop policy if exists events_insert on public.events;

drop policy if exists events_insert on public.events;

create policy events_insert on public.events for insert to authenticated
  with check (
    host = auth.uid()
    and (community_id is null or public.is_community_member(community_id))
    and (organization_id is null or public.org_role(organization_id) in ('owner','admin','editor'))
  );

drop policy if exists events_org_update on public.events;

create policy events_org_update on public.events for update to authenticated
  using (organization_id is not null and public.org_role(organization_id) in ('owner','admin','editor'))
  with check (organization_id is not null and public.org_role(organization_id) in ('owner','admin','editor'));

grant insert (organization_id) on public.events to authenticated;

-- ------------------------------------------------ entitlements (no payments here)
-- Subscriptions are written only by a verified payment-provider webhook running with the
-- service role (which bypasses RLS). Clients can read their own and nothing else.
create table if not exists public.plans (
  id text primary key,
  features text[] not null default '{}'
);

create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete cascade,
  organization_id uuid references public.organizations(id) on delete cascade,
  plan_id text not null references public.plans(id),
  status text not null check (status in ('trialing','active','past_due','canceled')),
  provider text not null,
  provider_ref text not null,
  current_period_end timestamptz,
  created_at timestamptz not null default now(),
  check ((user_id is null) <> (organization_id is null)),
  unique (provider, provider_ref)
);

-- Webhook idempotency ledger: one row per provider event id. No client access.
create table if not exists public.provider_events (
  provider text not null,
  event_id text not null,
  received_at timestamptz not null default now(),
  primary key (provider, event_id)
);

alter table public.plans enable row level security;

alter table public.subscriptions enable row level security;

alter table public.provider_events enable row level security;

drop policy if exists plans_select on public.plans;

create policy plans_select on public.plans for select to authenticated using (true);

drop policy if exists subs_select on public.subscriptions;
