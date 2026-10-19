-- Part B4/5: policies for conversations, messages, notifications, reports, audit_log
-- conversations/members are created only through the RPCs below.
drop policy if exists conv_select on public.conversations;
create policy conv_select on public.conversations for select to authenticated using (public.is_conversation_member(id));
drop policy if exists cmem_select on public.conversation_members;
create policy cmem_select on public.conversation_members for select to authenticated using (public.is_conversation_member(conversation_id));
drop policy if exists cmem_update_self on public.conversation_members;
create policy cmem_update_self on public.conversation_members for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists cmem_leave on public.conversation_members;
create policy cmem_leave on public.conversation_members for delete to authenticated using (user_id = auth.uid());

drop policy if exists messages_select on public.messages;
create policy messages_select on public.messages for select to authenticated using (public.is_conversation_member(conversation_id));
drop policy if exists messages_insert on public.messages;
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
