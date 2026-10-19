-- Part B2/5: policies for events, rsvps, posts
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
create policy rsvps_self on public.event_rsvps for insert to authenticated
  with check (
    user_id = auth.uid() and status in ('going','maybe','declined')
    and exists (select 1 from public.events e where e.id = event_id and e.status = 'active')
  );
drop policy if exists rsvps_invite on public.event_rsvps;
create policy rsvps_invite on public.event_rsvps for insert to authenticated
  with check (
    status = 'invited' and user_id <> auth.uid()
    and exists (select 1 from public.events e where e.id = event_id and e.host = auth.uid())
    and not public.is_blocked(auth.uid(), user_id)
  );
drop policy if exists rsvps_update on public.event_rsvps;
create policy rsvps_update on public.event_rsvps for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid() and status in ('going','maybe','declined'));
drop policy if exists rsvps_delete on public.event_rsvps;
create policy rsvps_delete on public.event_rsvps for delete to authenticated
  using (user_id = auth.uid() or exists (select 1 from public.events e where e.id = event_id and e.host = auth.uid()));

drop policy if exists posts_select on public.posts;
create policy posts_select on public.posts for select to authenticated using (public.can_view_post(posts));
drop policy if exists posts_insert on public.posts;
create policy posts_insert on public.posts for insert to authenticated
  with check (
    author = auth.uid()
    and (community_id is null or public.is_community_member(community_id))
    and (media_path is null or media_path like auth.uid()::text || '/%')
  );
drop policy if exists posts_update on public.posts;
create policy posts_update on public.posts for update to authenticated using (author = auth.uid()) with check (author = auth.uid());
drop policy if exists posts_delete on public.posts;
create policy posts_delete on public.posts for delete to authenticated
  using (author = auth.uid() or (community_id is not null and public.can_moderate_community(community_id)));
