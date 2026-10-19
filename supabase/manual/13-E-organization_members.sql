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

grant update (name, description, avatar_path) on public.organizations to authenticated;

grant delete on public.organizations to authenticated;

grant insert (organization_id, user_id, role, status) on public.organization_members to authenticated;

grant update (status) on public.organization_members to authenticated;

grant delete on public.organization_members to authenticated;
