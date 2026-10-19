-- Part B3/5: policies for comments, reactions, saves
drop policy if exists comments_select on public.comments;
create policy comments_select on public.comments for select to authenticated
  using (exists (select 1 from public.posts p where p.id = post_id));
drop policy if exists comments_insert on public.comments;
create policy comments_insert on public.comments for insert to authenticated
  with check (author = auth.uid() and exists (select 1 from public.posts p where p.id = post_id));
drop policy if exists comments_update on public.comments;
create policy comments_update on public.comments for update to authenticated using (author = auth.uid()) with check (author = auth.uid());
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
