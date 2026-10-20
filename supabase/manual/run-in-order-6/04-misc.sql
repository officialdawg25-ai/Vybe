drop trigger if exists post_tag_guard on public.post_tags;

create trigger post_tag_guard before insert on public.post_tags for each row execute function public.trg_post_tag();

-- Music picker: For you (followed artists first, then newest), Trending (most used in the last 14 days), Saved.
create or replace function public.music_catalog(p_tab text default 'foryou', p_q text default null, p_limit integer default 40) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare me uuid := auth.uid(); q text := nullif(btrim(replace(replace(coalesce(p_q, ''), '%', ''), '_', '')), ''); r jsonb;
begin
  if me is null then raise exception 'Sign in' using errcode = '28000'; end if;
  select coalesce(jsonb_agg(x.j order by x.rank1 desc, x.rank2 desc, x.created_at desc), '[]'::jsonb) into r from (
    select jsonb_build_object('id', t.id, 'title', t.title, 'artist', t.artist, 'artwork_path', t.artwork_path, 'preview_path', t.preview_path, 'external_url', t.external_url,
             'saved', exists (select 1 from public.saved_tracks s where s.user_id = me and s.track_id = t.id)) as j,
           case p_tab when 'trending' then (select count(*) from public.posts p where p.music_track_id = t.id and p.created_at > now() - interval '14 days')
                      else (case when exists (select 1 from public.follows f join public.organizations o on o.id = f.target_id and f.target_type = 'organization' where f.follower = me and lower(o.name) = lower(t.artist)) then 1 else 0 end) end as rank1,
           0 as rank2, t.created_at
    from public.music_tracks t
    where t.active and (q is null or t.title ilike '%' || q || '%' or t.artist ilike '%' || q || '%')
      and (p_tab <> 'saved' or exists (select 1 from public.saved_tracks s where s.user_id = me and s.track_id = t.id))
    order by 2 desc, t.created_at desc
    limit least(greatest(p_limit, 1), 100)
  ) x;
  return r;
end $$;

-- ---------------------------------------------------------------- memories (24-hour moments)
create table if not exists public.memories (
  id uuid primary key default gen_random_uuid(),
  author uuid not null references public.profiles(id) on delete cascade,
  kind text not null check (kind in ('photo', 'video', 'text')),
  media_path text,
  text_body text not null default '' check (char_length(text_body) <= 500),
  bg text not null default 'violet' check (bg in ('violet', 'teal', 'rose', 'sun', 'night', 'ocean')),
  visibility text not null default 'friends' check (visibility in ('public', 'friends')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '24 hours',
  highlight boolean not null default false,
  highlight_title text check (highlight_title is null or char_length(highlight_title) <= 40),
  check ((kind = 'text') = (media_path is null)),
  check (kind <> 'text' or btrim(text_body) <> ''),
  check (media_path is null or media_path like author::text || '/%')
);

create index if not exists memories_author_idx on public.memories (author, created_at desc);

create index if not exists memories_active_idx on public.memories (expires_at desc);

alter table public.memories enable row level security;

create or replace function public.can_view_memory(m public.memories) returns boolean
language sql stable security definer set search_path = '' as $$
  select m.author = auth.uid() or (
    not public.is_blocked(auth.uid(), m.author)
    and (m.expires_at > now() or m.highlight)
    and (m.visibility = 'public' or (m.visibility = 'friends' and public.are_friends(auth.uid(), m.author)))
  );
$$;
