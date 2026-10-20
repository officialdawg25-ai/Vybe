-- Rail: people with a live memory you may see — friends first, unseen first. Aggregates + a cover only.
create or replace function public.memory_rail(p_limit integer default 30) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare me uuid := auth.uid(); r jsonb;
begin
  if me is null then raise exception 'Sign in' using errcode = '28000'; end if;
  with vis as (
    select m.* from public.memories m where m.author <> me and m.expires_at > now() and public.can_view_memory(m)
  ), by_author as (
    select v.author, count(*) as n, max(v.created_at) as latest,
           count(*) filter (where not exists (select 1 from public.memory_views mv where mv.memory_id = v.id and mv.viewer = me)) as unseen
    from vis v group by v.author
  ), ranked as (
    select b.*, public.are_friends(me, b.author) as friend from by_author b order by (b.unseen > 0) desc, public.are_friends(me, b.author) desc, b.latest desc
    limit least(greatest(p_limit, 1), 60)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'author', (select jsonb_build_object('id', p.id, 'username', p.username, 'display_name', p.display_name, 'avatar_path', p.avatar_path, 'verified_until', p.verified_until) from public.profiles p where p.id = ra.author),
    'count', ra.n, 'unseen', ra.unseen, 'latest_at', ra.latest, 'friend', ra.friend,
    'cover', (select jsonb_build_object('kind', v.kind, 'media_path', v.media_path, 'text_body', v.text_body, 'bg', v.bg) from vis v where v.author = ra.author order by v.created_at desc limit 1)
  ) order by (ra.unseen > 0) desc, ra.friend desc, ra.latest desc), '[]'::jsonb) into r from ranked ra;
  return r;
end $$;

-- One person's memories in order. For the owner it also returns the counts they are allowed to see.
create or replace function public.author_memories(p_author uuid, p_highlights boolean default false) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare me uuid := auth.uid(); r jsonb;
begin
  if me is null then raise exception 'Sign in' using errcode = '28000'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', m.id, 'kind', m.kind, 'media_path', m.media_path, 'text_body', m.text_body, 'bg', m.bg, 'created_at', m.created_at, 'expires_at', m.expires_at,
    'visibility', m.visibility, 'highlight', m.highlight, 'highlight_title', m.highlight_title,
    'mine_reaction', (select emoji from public.memory_reactions x where x.memory_id = m.id and x.user_id = me),
    'seen', exists (select 1 from public.memory_views v where v.memory_id = m.id and v.viewer = me),
    'views', case when m.author = me then (select count(*) from public.memory_views v where v.memory_id = m.id) end,
    'reactions', case when m.author = me then (select count(*) from public.memory_reactions x where x.memory_id = m.id) end,
    'replies', case when m.author = me then (select count(*) from public.memory_replies y where y.memory_id = m.id) end
  ) order by m.created_at), '[]'::jsonb) into r
  from public.memories m
  where m.author = p_author and public.can_view_memory(m)
    and ((p_highlights and m.highlight) or (not p_highlights and m.expires_at > now()));
  return r;
end $$;

-- Messages can carry a photo/video or a voice note (stored in the private media bucket under the sender's folder).
alter table public.messages drop constraint if exists messages_body_check;

alter table public.messages drop constraint if exists messages_body_len;

alter table public.messages add constraint messages_body_len check (char_length(body) <= 4000);

alter table public.messages add column if not exists media_path text;

alter table public.messages add column if not exists media_type text check (media_type is null or media_type in ('image', 'video'));

alter table public.messages add column if not exists audio_path text;

alter table public.messages add column if not exists audio_ms integer check (audio_ms is null or audio_ms between 500 and 61000);

alter table public.messages drop constraint if exists messages_has_content;
