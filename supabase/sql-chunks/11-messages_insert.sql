create policy messages_insert on public.messages for insert to authenticated
  with check (sender = auth.uid() and public.is_conversation_member(conversation_id));

drop policy if exists messages_update on public.messages;

create policy messages_update on public.messages for update to authenticated using (sender = auth.uid()) with check (sender = auth.uid());

drop policy if exists notifications_select on public.notifications;

create policy notifications_select on public.notifications for select to authenticated using (user_id = auth.uid());

drop policy if exists notifications_update on public.notifications;

create policy notifications_update on public.notifications for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists notifications_delete on public.notifications;

create policy notifications_delete on public.notifications for delete to authenticated using (user_id = auth.uid());

drop policy if exists reports_insert on public.reports;

create policy reports_insert on public.reports for insert to authenticated with check (reporter = auth.uid() and status = 'submitted');

drop policy if exists reports_select on public.reports;

create policy reports_select on public.reports for select to authenticated using (reporter = auth.uid() or public.is_staff());

drop policy if exists reports_staff_update on public.reports;

create policy reports_staff_update on public.reports for update to authenticated using (public.is_staff()) with check (public.is_staff());

drop policy if exists audit_staff_select on public.audit_log;

create policy audit_staff_select on public.audit_log for select to authenticated using (public.is_staff());

-- Column-level grants: clients cannot rewrite ownership, authorship or history.
revoke all on all tables in schema public from anon, authenticated;

grant select on public.profiles, public.blocks, public.friendships, public.communities, public.community_members,
  public.events, public.event_rsvps, public.posts, public.comments, public.reactions, public.saves,
  public.conversations, public.conversation_members, public.messages, public.notifications,
  public.reports, public.audit_log to authenticated;

grant update (display_name, bio, avatar_path, location, interests, dm_policy, onboarded_at) on public.profiles to authenticated;

grant insert, delete on public.blocks to authenticated;

grant insert, delete on public.friendships to authenticated;

grant update (status) on public.friendships to authenticated;

grant insert, delete on public.communities to authenticated;

grant update (name, description, rules, cover_path, topics, visibility) on public.communities to authenticated;

grant insert, delete on public.community_members to authenticated;

grant update (role, status) on public.community_members to authenticated;

grant insert, delete on public.events to authenticated;
