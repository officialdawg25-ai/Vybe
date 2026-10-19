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

drop policy if exists comments_select on public.comments;

create policy comments_select on public.comments for select to authenticated
  using (exists (select 1 from public.posts p where p.id = post_id));

drop policy if exists comments_insert on public.comments;

create policy comments_insert on public.comments for insert to authenticated
  with check (author = auth.uid() and exists (select 1 from public.posts p where p.id = post_id));

drop policy if exists comments_update on public.comments;

create policy comments_update on public.comments for update to authenticated using (author = auth.uid()) with check (author = auth.uid());
