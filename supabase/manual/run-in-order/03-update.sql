-- Run 03-update.sql (storage/platform/brand hero set), in filename order. Re-runnable.
grant update (name, description, avatar_path) on public.organizations to authenticated;

grant delete on public.organizations to authenticated;

grant insert (organization_id, user_id, role, status) on public.organization_members to authenticated;

grant update (status) on public.organization_members to authenticated;

grant delete on public.organization_members to authenticated;

create or replace function public.trg_org_owner() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.organization_members (organization_id, user_id, role, status) values (new.id, new.created_by, 'owner', 'active');
  return new;
end $$;

drop trigger if exists org_owner on public.organizations;

create trigger org_owner after insert on public.organizations for each row execute function public.trg_org_owner();

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
