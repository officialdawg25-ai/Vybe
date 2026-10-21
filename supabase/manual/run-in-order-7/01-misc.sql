-- Chat attachments of any type, unlimited voice notes, songs from the device, unread message count and 1:1 voice/video calls.
-- Additive and re-runnable.

-- ---------------------------------------------------------------- voice notes: no 60-second ceiling
-- A voice note may now be any length (up to 24 hours as a sanity bound); the practical limit is the storage upload size.
do $$
declare c record;
begin
  for c in select conrelid::regclass as tbl, conname from pg_constraint
           where contype = 'c' and conrelid in ('public.comments'::regclass, 'public.memory_replies'::regclass, 'public.messages'::regclass)
             and pg_get_constraintdef(oid) like '%audio_ms%' and pg_get_constraintdef(oid) like '%61000%' loop
    execute format('alter table %s drop constraint %I', c.tbl, c.conname);
  end loop;
end $$;

alter table public.comments drop constraint if exists comments_audio_valid;

alter table public.comments add constraint comments_audio_valid
  check ((audio_path is null) = (audio_ms is null) and (audio_ms is null or audio_ms between 500 and 86400000) and (audio_path is null or audio_path like author::text || '/%'));

alter table public.memory_replies drop constraint if exists memory_replies_audio_ms_len;

alter table public.memory_replies add constraint memory_replies_audio_ms_len check (audio_ms is null or audio_ms between 500 and 86400000);

alter table public.messages drop constraint if exists messages_audio_ms_len;

alter table public.messages add constraint messages_audio_ms_len check (audio_ms is null or audio_ms between 500 and 86400000);

-- Larger uploads in the media bucket (long voice notes). The client still caps photos at 25 MB and videos at 50 MB.
-- Supabase also has a project-wide upload limit (Dashboard → Storage → Settings); raise it there to allow very long recordings.
update storage.buckets set file_size_limit = 262144000,
  allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/webm', 'video/quicktime',
                             'audio/webm', 'audio/mp4', 'audio/ogg', 'audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/aac', 'audio/x-m4a', 'audio/flac', 'audio/opus']
 where id = 'media';

-- ---------------------------------------------------------------- songs from the member's own device
alter table public.posts add column if not exists music_path text check (music_path is null or char_length(music_path) <= 200);

alter table public.posts drop constraint if exists posts_music_path_owner;

alter table public.posts add constraint posts_music_path_owner check (music_path is null or music_path like author::text || '/%');

-- ---------------------------------------------------------------- chat attachments of any type
alter table public.messages add column if not exists file_path text;

alter table public.messages add column if not exists file_name text check (file_name is null or char_length(file_name) between 1 and 200);

alter table public.messages add column if not exists file_size bigint check (file_size is null or file_size between 0 and 2147483648);

alter table public.messages add column if not exists file_mime text check (file_mime is null or char_length(file_mime) <= 120);

alter table public.messages drop constraint if exists messages_file_set;

alter table public.messages add constraint messages_file_set check ((file_path is null) = (file_name is null) and (file_path is null or file_path !~ '\.\.'));

alter table public.messages drop constraint if exists messages_has_content;

alter table public.messages add constraint messages_has_content
  check (btrim(body) <> '' or media_path is not null or audio_path is not null or file_path is not null or deleted_at is not null);

drop policy if exists messages_insert on public.messages;
