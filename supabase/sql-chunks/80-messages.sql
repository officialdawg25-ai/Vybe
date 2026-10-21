alter table public.messages add constraint messages_file_set check ((file_path is null) = (file_name is null) and (file_path is null or file_path !~ '\.\.'));

alter table public.messages drop constraint if exists messages_has_content;

alter table public.messages add constraint messages_has_content
  check (btrim(body) <> '' or media_path is not null or audio_path is not null or file_path is not null or deleted_at is not null);

drop policy if exists messages_insert on public.messages;

create policy messages_insert on public.messages for insert to authenticated
  with check (sender = auth.uid() and public.is_conversation_member(conversation_id)
    and (media_path is null or media_path like auth.uid()::text || '/%') and (audio_path is null or audio_path like auth.uid()::text || '/%')
    and (file_path is null or file_path like auth.uid()::text || '/%'));

-- Private bucket for chat files: readable by the sender and by members of the conversation the file was sent in.
-- Executable and script types are refused by name.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('attachments', 'attachments', false, 262144000, null)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = null;

drop policy if exists attachments_insert on storage.objects;

create policy attachments_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'attachments' and (storage.foldername(name))[1] = auth.uid()::text
    and name !~* '\.(exe|msi|bat|cmd|com|scr|pif|js|jse|vbs|vbe|wsf|ps1|apk|jar|sh|dll|app|dmg|lnk|hta|reg|iso)$');

drop policy if exists attachments_select on storage.objects;

create policy attachments_select on storage.objects for select to authenticated
  using (bucket_id = 'attachments' and ((storage.foldername(name))[1] = auth.uid()::text
    or exists (select 1 from public.messages m where m.file_path = name and public.is_conversation_member(m.conversation_id))));

drop policy if exists attachments_delete on storage.objects;

create policy attachments_delete on storage.objects for delete to authenticated
  using (bucket_id = 'attachments' and (storage.foldername(name))[1] = auth.uid()::text);

-- Media bucket readability: now also the device song attached to a post.
drop policy if exists media_select_visible on storage.objects;

create policy media_select_visible on storage.objects for select to authenticated
  using (
    bucket_id = 'media' and (
      (storage.foldername(name))[1] = auth.uid()::text
      or exists (select 1 from public.posts p where p.media_path = name or p.music_path = name)
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
