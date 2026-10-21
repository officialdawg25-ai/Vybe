drop policy if exists post_media_read on public.post_media;

create policy post_media_read on public.post_media for select to authenticated using (exists (select 1 from public.posts p where p.id = post_id));

-- posts RLS decides
drop policy if exists post_media_ins on public.post_media;

create policy post_media_ins on public.post_media for insert to authenticated
  with check (exists (select 1 from public.posts p where p.id = post_id and p.author = auth.uid()) and path like auth.uid()::text || '/%');

drop policy if exists post_media_del on public.post_media;

create policy post_media_del on public.post_media for delete to authenticated using (exists (select 1 from public.posts p where p.id = post_id and p.author = auth.uid()));

revoke all on public.post_media from anon, authenticated;

grant select, insert, delete on public.post_media to authenticated;

-- Existing single-media posts become gallery item 0 so every reader can use one code path.
insert into public.post_media (post_id, sort, path, type) select id, 0, media_path, media_type from public.posts where media_path is not null on conflict do nothing;

create table if not exists public.post_tags (
  post_id uuid not null references public.posts(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);

create index if not exists post_tags_user_idx on public.post_tags (user_id, created_at desc);

alter table public.post_tags enable row level security;

drop policy if exists post_tags_read on public.post_tags;

create policy post_tags_read on public.post_tags for select to authenticated using (exists (select 1 from public.posts p where p.id = post_id));

drop policy if exists post_tags_ins on public.post_tags;

create policy post_tags_ins on public.post_tags for insert to authenticated
  with check (exists (select 1 from public.posts p where p.id = post_id and p.author = auth.uid()) and user_id <> auth.uid() and public.are_friends(auth.uid(), user_id));

drop policy if exists post_tags_del on public.post_tags;

create policy post_tags_del on public.post_tags for delete to authenticated
  using (user_id = auth.uid() or exists (select 1 from public.posts p where p.id = post_id and p.author = auth.uid()));

-- the tagged person can always remove the tag
revoke all on public.post_tags from anon, authenticated;

grant select, insert, delete on public.post_tags to authenticated;

create or replace function public.trg_post_tag() returns trigger
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  select count(*) into n from public.post_tags where post_id = new.post_id;
  if n >= 10 then raise exception 'You can tag up to 10 people'; end if;
  perform public.notify(new.user_id, 'post_tag', (select author from public.posts where id = new.post_id), 'post', new.post_id, 'tag:' || new.post_id || ':' || new.user_id);
  return new;
end $$;
