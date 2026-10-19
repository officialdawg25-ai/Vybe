create or replace function public.delete_my_account() returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  delete from auth.users where id = auth.uid();
end $$;

revoke execute on function public.start_dm(uuid), public.start_group(text, uuid[]), public.delete_my_account() from public, anon;

grant execute on function public.start_dm(uuid), public.start_group(text, uuid[]), public.delete_my_account() to authenticated;

-- Staff role helper must not be callable by anon.
revoke execute on function public.is_staff() from public, anon;

grant execute on function public.is_staff() to authenticated;

-- Private media bucket. Objects are readable only by their owner or by anyone who
-- can already see a row (post, profile, event, community) that references the path,
-- so a leaked storage path does not make private media public.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('media', 'media', false, 52428800,
  array['image/jpeg','image/png','image/webp','image/gif','video/mp4','video/webm','video/quicktime'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists media_insert_own on storage.objects;

create policy media_insert_own on storage.objects for insert to authenticated
  with check (bucket_id = 'media' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists media_delete_own on storage.objects;

create policy media_delete_own on storage.objects for delete to authenticated
  using (bucket_id = 'media' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists media_select_visible on storage.objects;

create policy media_select_visible on storage.objects for select to authenticated
  using (
    bucket_id = 'media' and (
      (storage.foldername(name))[1] = auth.uid()::text
      or exists (select 1 from public.posts p where p.media_path = name)
      or exists (select 1 from public.profiles pr where pr.avatar_path = name)
      or exists (select 1 from public.events e where e.cover_path = name)
      or exists (select 1 from public.communities c where c.cover_path = name)
    )
  );

-- VYBE platform layer: notification preferences, organizations, entitlements,
-- live-stream scheduling, and least-privilege staff moderation. Additive only.

-- ------------------------------------------------- notification preferences
alter table public.profiles add column if not exists notif_prefs jsonb not null default '{}'::jsonb;

grant update (notif_prefs) on public.profiles to authenticated;
