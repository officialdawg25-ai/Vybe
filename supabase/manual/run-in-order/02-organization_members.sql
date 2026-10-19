-- Run 02-organization_members.sql (storage/platform/brand hero set), in filename order. Re-runnable.
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

alter table public.organization_members enable row level security;

drop policy if exists orgs_select on public.organizations;

create policy orgs_select on public.organizations for select to authenticated using (true);

drop policy if exists orgs_insert on public.organizations;

create policy orgs_insert on public.organizations for insert to authenticated
  with check (created_by = auth.uid() and verified_at is null);

drop policy if exists orgs_update on public.organizations;

create policy orgs_update on public.organizations for update to authenticated
  using (public.org_role(id) in ('owner','admin')) with check (public.org_role(id) in ('owner','admin'));

drop policy if exists orgs_delete on public.organizations;

create policy orgs_delete on public.organizations for delete to authenticated using (public.org_role(id) = 'owner');

drop policy if exists om_select on public.organization_members;

create policy om_select on public.organization_members for select to authenticated
  using (user_id = auth.uid() or public.org_role(organization_id) is not null);

drop policy if exists om_invite on public.organization_members;

create policy om_invite on public.organization_members for insert to authenticated
  with check (public.org_role(organization_id) in ('owner','admin') and status = 'invited' and role in ('admin','editor') and user_id <> auth.uid()
              and not public.is_blocked(auth.uid(), user_id));

-- An invitee accepts their own invitation (and nothing else about it).
drop policy if exists om_accept on public.organization_members;

create policy om_accept on public.organization_members for update to authenticated
  using (user_id = auth.uid() and status = 'invited') with check (user_id = auth.uid() and status = 'active');

drop policy if exists om_remove on public.organization_members;

create policy om_remove on public.organization_members for delete to authenticated
  using ((user_id = auth.uid() and role <> 'owner') or (public.org_role(organization_id) in ('owner','admin') and role <> 'owner'));

revoke all on public.organizations, public.organization_members from anon, authenticated;

grant select on public.organizations, public.organization_members to authenticated;

grant insert (name, slug, kind, description, avatar_path, created_by) on public.organizations to authenticated;
