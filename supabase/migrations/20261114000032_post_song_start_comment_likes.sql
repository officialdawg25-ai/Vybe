-- Migration 32: where a post's song starts, and likes on comments. Additive and re-runnable.
--
-- 1. posts.music_start_ms: the moment of the song a post plays (chosen in "Choose the moment"), like memories.music_start_ms
--    and reels' reel_edit.ms. Null/0 means from the beginning.
-- 2. comment_reactions: one like per person per comment. Readable exactly when the comment is (its own rule decides),
--    written only by the person themselves. Counts come from aggregate embeds, as for posts.

alter table public.posts add column if not exists music_start_ms integer
  check (music_start_ms is null or music_start_ms between 0 and 3600000);

create table if not exists public.comment_reactions (
  comment_id uuid not null references public.comments(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (comment_id, user_id)
);
create index if not exists comment_reactions_user_idx on public.comment_reactions (user_id);
alter table public.comment_reactions enable row level security;
revoke all on public.comment_reactions from anon, authenticated;
grant select, insert, delete on public.comment_reactions to authenticated;

drop policy if exists comment_reactions_select on public.comment_reactions;
create policy comment_reactions_select on public.comment_reactions for select to authenticated
  using (exists (select 1 from public.comments c where c.id = comment_id));
drop policy if exists comment_reactions_insert on public.comment_reactions;
create policy comment_reactions_insert on public.comment_reactions for insert to authenticated
  with check (user_id = (select auth.uid()) and exists (select 1 from public.comments c where c.id = comment_id));
drop policy if exists comment_reactions_delete on public.comment_reactions;
create policy comment_reactions_delete on public.comment_reactions for delete to authenticated
  using (user_id = (select auth.uid()));

-- 3. Online status ("green dot") for friends only. Each signed-in member announces themselves on their own private Realtime
--    channel `online:<their id>`; only they can announce there, and only they and their accepted friends can listen.
--    Nobody else can learn whether someone is online. (Skipped where Realtime is not installed, e.g. local test databases.)
do $$
begin
  if to_regclass('realtime.messages') is null then return; end if;
  execute 'drop policy if exists vybe_online_listen on realtime.messages';
  execute $p$
    create policy vybe_online_listen on realtime.messages for select to authenticated using (
      realtime.messages.extension = 'presence' and case
        when realtime.topic() ~ '^online:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          then split_part(realtime.topic(), ':', 2)::uuid = (select auth.uid())
            or public.are_friends((select auth.uid()), split_part(realtime.topic(), ':', 2)::uuid)
        else false end)
  $p$;
  execute 'drop policy if exists vybe_online_announce on realtime.messages';
  execute $p$
    create policy vybe_online_announce on realtime.messages for insert to authenticated with check (
      realtime.messages.extension = 'presence' and realtime.topic() = 'online:' || (select auth.uid())::text)
  $p$;
end $$;
