-- Voice-note comments (max 60 s). Audio lives in the private `media` bucket under the author's folder and is
-- readable exactly where the comment is (same rule as post media). Additive and re-runnable.

alter table public.comments add column if not exists audio_path text;
alter table public.comments add column if not exists audio_ms integer;

-- A comment needs text or a voice note; the old "body between 1 and 2000" rule becomes "up to 2000, and not empty unless audio".
alter table public.comments drop constraint if exists comments_body_check;
alter table public.comments drop constraint if exists comments_body_or_audio;
alter table public.comments add constraint comments_body_or_audio
  check (char_length(body) <= 2000 and (char_length(body) >= 1 or audio_path is not null));
alter table public.comments drop constraint if exists comments_audio_valid;
alter table public.comments add constraint comments_audio_valid
  check ((audio_path is null) = (audio_ms is null)
         and (audio_ms is null or audio_ms between 500 and 61000)
         and (audio_path is null or audio_path like author::text || '/%'));

update storage.buckets
   set allowed_mime_types = array['image/jpeg','image/png','image/webp','image/gif','video/mp4','video/webm','video/quicktime',
                                  'audio/webm','audio/mp4','audio/ogg','audio/mpeg']
 where id = 'media';

drop policy if exists media_select_visible on storage.objects;
create policy media_select_visible on storage.objects for select to authenticated
  using (
    bucket_id = 'media' and (
      (storage.foldername(name))[1] = auth.uid()::text
      or exists (select 1 from public.posts p where p.media_path = name)
      or exists (select 1 from public.comments c where c.audio_path = name)
      or exists (select 1 from public.profiles pr where pr.avatar_path = name)
      or exists (select 1 from public.events e where e.cover_path = name)
      or exists (select 1 from public.communities c where c.cover_path = name)
    )
  );
