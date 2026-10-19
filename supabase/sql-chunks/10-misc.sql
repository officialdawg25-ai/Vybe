drop policy if exists comments_delete on public.comments;

create policy comments_delete on public.comments for delete to authenticated
  using (author = auth.uid() or exists (select 1 from public.posts p where p.id = post_id and p.author = auth.uid()));

drop policy if exists reactions_select on public.reactions;

create policy reactions_select on public.reactions for select to authenticated
  using (exists (select 1 from public.posts p where p.id = post_id));

drop policy if exists reactions_insert on public.reactions;

create policy reactions_insert on public.reactions for insert to authenticated
  with check (user_id = auth.uid() and exists (select 1 from public.posts p where p.id = post_id));

drop policy if exists reactions_update on public.reactions;

create policy reactions_update on public.reactions for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists reactions_delete on public.reactions;

create policy reactions_delete on public.reactions for delete to authenticated using (user_id = auth.uid());

drop policy if exists saves_select on public.saves;

create policy saves_select on public.saves for select to authenticated using (user_id = auth.uid());

drop policy if exists saves_insert on public.saves;

create policy saves_insert on public.saves for insert to authenticated
  with check (user_id = auth.uid() and exists (select 1 from public.posts p where p.id = post_id));

drop policy if exists saves_delete on public.saves;

create policy saves_delete on public.saves for delete to authenticated using (user_id = auth.uid());

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
