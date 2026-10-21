alter table public.messages add constraint messages_has_content check (btrim(body) <> '' or media_path is not null or audio_path is not null or deleted_at is not null);

alter table public.messages drop constraint if exists messages_media_pair;

alter table public.messages add constraint messages_media_pair check ((media_path is null) = (media_type is null) and (audio_path is null) = (audio_ms is null));

drop policy if exists messages_insert on public.messages;

create policy messages_insert on public.messages for insert to authenticated
  with check (sender = auth.uid() and public.is_conversation_member(conversation_id)
    and (media_path is null or media_path like auth.uid()::text || '/%') and (audio_path is null or audio_path like auth.uid()::text || '/%'));

-- Media for memories and the extra post media/cover photos is readable exactly where the row is readable.
drop policy if exists media_select_visible on storage.objects;

create policy media_select_visible on storage.objects for select to authenticated
  using (
    bucket_id = 'media' and (
      (storage.foldername(name))[1] = auth.uid()::text
      or exists (select 1 from public.posts p where p.media_path = name)
      or exists (select 1 from public.post_media pm where pm.path = name)
      or exists (select 1 from public.comments c where c.audio_path = name)
      or exists (select 1 from public.profiles pr where pr.avatar_path = name or pr.cover_path = name)
      or exists (select 1 from public.events e where e.cover_path = name)
      or exists (select 1 from public.event_lineup l where l.image_path = name)
      or exists (select 1 from public.communities c where c.cover_path = name)
      or exists (select 1 from public.memories m where m.media_path = name)
      or exists (select 1 from public.memory_replies r where r.audio_path = name)
      or exists (select 1 from public.messages m where m.media_path = name or m.audio_path = name)
    )
  );

-- Music artwork and previews go in the public `brand` bucket under music/ (admins only), like hero and promo media.
update storage.buckets set allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm', 'audio/mpeg', 'audio/mp4', 'audio/ogg'] where id = 'brand';

drop policy if exists brand_admin_insert on storage.objects;

create policy brand_admin_insert on storage.objects for insert to authenticated
  with check (bucket_id in ('brand', 'brand-draft') and public.is_admin()
    and (name ~ '^(hero|promo)/[0-9a-f-]{36}\.(jpg|png|webp|mp4|webm)$' or name ~ '^music/[0-9a-f-]{36}\.(jpg|png|webp|mp3|m4a|ogg)$'));

-- ---------------------------------------------------------------- profile details (per-section visibility)
create table if not exists public.profile_details (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  about text not null default '' check (char_length(about) <= 500),
  current_city text check (current_city is null or char_length(current_city) <= 80),
  hometown text check (hometown is null or char_length(hometown) <= 80),
  relationship text check (relationship is null or relationship in ('single', 'in_a_relationship', 'engaged', 'married', 'complicated', 'prefer_not')),
  gender text check (gender is null or gender in ('male', 'female', 'nonbinary', 'prefer_not')),
  birthday_visible boolean not null default false,
  languages text[] not null default '{}' check (cardinality(languages) <= 8),
  education jsonb not null default '[]' check (jsonb_typeof(education) = 'array' and jsonb_array_length(education) <= 5),
  work jsonb not null default '[]' check (jsonb_typeof(work) = 'array' and jsonb_array_length(work) <= 5),
  hobbies text[] not null default '{}' check (cardinality(hobbies) <= 12),
  travel text[] not null default '{}' check (cardinality(travel) <= 20),
  links jsonb not null default '[]' check (jsonb_typeof(links) = 'array' and jsonb_array_length(links) <= 5),
  contact jsonb not null default '{}' check (jsonb_typeof(contact) = 'object'),
  visibility jsonb not null default '{"about":"public","personal":"public","work":"public","education":"public","hobbies":"public","travel":"public","links":"public","contact":"friends"}',
  updated_at timestamptz not null default now()
);
