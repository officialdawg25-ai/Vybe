drop policy if exists communities_update on public.communities;

create policy communities_update on public.communities for update to authenticated
  using (public.community_role(id) in ('owner','admin')) with check (created_by = (select c.created_by from public.communities c where c.id = communities.id));

drop policy if exists communities_delete on public.communities;

create policy communities_delete on public.communities for delete to authenticated using (created_by = auth.uid());

drop policy if exists cm_select on public.community_members;

create policy cm_select on public.community_members for select to authenticated
  using (user_id = auth.uid() or public.is_community_member(community_id) or public.community_is_public(community_id));

drop policy if exists cm_join on public.community_members;

create policy cm_join on public.community_members for insert to authenticated
  with check (
    user_id = auth.uid() and role = 'member'
    and ((public.community_is_public(community_id) and status = 'active')
      or (not public.community_is_public(community_id) and status = 'pending'))
  );

drop policy if exists cm_manage on public.community_members;

create policy cm_manage on public.community_members for update to authenticated
  using (public.can_moderate_community(community_id) and role <> 'owner')
  with check (role in ('member','moderator','admin') and (role = 'member' or public.community_role(community_id) in ('owner','admin')));

drop policy if exists cm_leave_or_remove on public.community_members;

create policy cm_leave_or_remove on public.community_members for delete to authenticated
  using ((user_id = auth.uid() and role <> 'owner') or (public.can_moderate_community(community_id) and role <> 'owner'));

drop policy if exists events_select on public.events;

create policy events_select on public.events for select to authenticated using (public.can_view_event(events));

drop policy if exists events_insert on public.events;

create policy events_insert on public.events for insert to authenticated
  with check (host = auth.uid() and (community_id is null or public.is_community_member(community_id)));

drop policy if exists events_update on public.events;

create policy events_update on public.events for update to authenticated using (host = auth.uid()) with check (host = auth.uid());

drop policy if exists events_delete on public.events;

create policy events_delete on public.events for delete to authenticated using (host = auth.uid());

drop policy if exists rsvps_select on public.event_rsvps;

create policy rsvps_select on public.event_rsvps for select to authenticated
  using (user_id = auth.uid() or exists (select 1 from public.events e where e.id = event_id));

drop policy if exists rsvps_self on public.event_rsvps;
