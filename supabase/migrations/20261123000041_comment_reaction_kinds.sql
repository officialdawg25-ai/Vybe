-- 41: A choice of reactions on comments (love, like, haha, wow, sad, fire), not only a heart.
--
-- comment_reactions keeps one row per person per comment (the primary key), and now says which reaction it is. Existing rows
-- are hearts. A person can switch their reaction (update their own row) or take it back (delete it); nobody else can.
-- Additive. Rollback: drop policy comment_reactions_update; revoke update (reaction); drop column reaction.

alter table public.comment_reactions add column if not exists reaction text not null default 'heart';
alter table public.comment_reactions drop constraint if exists comment_reactions_reaction_ok;
alter table public.comment_reactions add constraint comment_reactions_reaction_ok check (reaction in ('heart', 'like', 'laugh', 'wow', 'sad', 'fire'));
grant update (reaction) on public.comment_reactions to authenticated;
drop policy if exists comment_reactions_update on public.comment_reactions;
create policy comment_reactions_update on public.comment_reactions for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
