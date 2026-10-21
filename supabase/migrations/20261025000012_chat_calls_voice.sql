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

-- ---------------------------------------------------------------- unread message count (header badge)
-- Capped at 100 so the badge stays cheap however much mail has piled up.
create or replace function public.unread_messages() returns integer
language sql stable security definer set search_path = '' as $$
  select least(count(*), 100)::integer from (
    select 1 from public.conversation_members cm
    join public.messages m on m.conversation_id = cm.conversation_id and m.created_at > cm.last_read_at and m.sender <> cm.user_id and m.deleted_at is null
    where cm.user_id = auth.uid()
    limit 100
  ) x;
$$;
revoke execute on function public.unread_messages() from public, anon;
grant execute on function public.unread_messages() to authenticated;

-- ---------------------------------------------------------------- 1:1 voice and video calls (media runs over LiveKit)
create table if not exists public.calls (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  caller uuid not null references public.profiles(id) on delete cascade,
  callee uuid not null references public.profiles(id) on delete cascade,
  kind text not null check (kind in ('audio', 'video')),
  status text not null default 'ringing' check (status in ('ringing', 'active', 'declined', 'ended', 'missed', 'cancelled')),
  room text not null unique default ('call-' || replace(gen_random_uuid()::text, '-', '')),
  created_at timestamptz not null default now(),
  answered_at timestamptz,
  ended_at timestamptz,
  check (caller <> callee)
);
create index if not exists calls_callee_idx on public.calls (callee, created_at desc);
create index if not exists calls_caller_idx on public.calls (caller, created_at desc);
alter table public.calls enable row level security;
drop policy if exists calls_read on public.calls;
create policy calls_read on public.calls for select to authenticated using (caller = auth.uid() or callee = auth.uid());
revoke all on public.calls from anon, authenticated;
grant select on public.calls to authenticated;

create or replace function public.start_call(p_conversation uuid, p_kind text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid(); other uuid; c public.calls; recent integer;
begin
  if me is null then raise exception 'Sign in' using errcode = '28000'; end if;
  if p_kind not in ('audio', 'video') then raise exception 'Choose a voice or video call'; end if;
  if not public.is_conversation_member(p_conversation) then raise exception 'You are not in this conversation'; end if;
  if exists (select 1 from public.conversations where id = p_conversation and is_group) then raise exception 'Calls are for one-to-one chats'; end if;
  select user_id into other from public.conversation_members where conversation_id = p_conversation and user_id <> me limit 1;
  if other is null then raise exception 'Nobody to call'; end if;
  if public.is_blocked(me, other) then raise exception 'You cannot call this person'; end if;
  select count(*) into recent from public.calls where caller = me and created_at > now() - interval '1 minute';
  if recent >= 6 then raise exception 'Too many calls. Please wait a moment.'; end if;
  update public.calls set status = 'missed', ended_at = now() where status = 'ringing' and created_at < now() - interval '60 seconds' and (caller = me or callee = other);
  update public.calls set status = 'cancelled', ended_at = now() where status = 'ringing' and caller = me;
  if exists (select 1 from public.calls where status in ('ringing', 'active') and (callee = other or caller = other) and coalesce(answered_at, created_at) > now() - interval '6 hours') then
    raise exception 'They are on another call';
  end if;
  insert into public.calls (conversation_id, caller, callee, kind) values (p_conversation, me, other, p_kind) returning * into c;
  return jsonb_build_object('id', c.id, 'room', c.room, 'kind', c.kind);
end $$;

create or replace function public.respond_call(p_call uuid, p_accept boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare c public.calls;
begin
  select * into c from public.calls where id = p_call and callee = auth.uid() for update;
  if not found then raise exception 'Call not found'; end if;
  if c.status <> 'ringing' or c.created_at < now() - interval '60 seconds' then
    update public.calls set status = 'missed', ended_at = now() where id = c.id and status = 'ringing';
    raise exception 'This call has ended';
  end if;
  if p_accept then update public.calls set status = 'active', answered_at = now() where id = c.id;
  else update public.calls set status = 'declined', ended_at = now() where id = c.id; end if;
end $$;

create or replace function public.end_call(p_call uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare c public.calls;
begin
  select * into c from public.calls where id = p_call and (caller = auth.uid() or callee = auth.uid()) for update;
  if not found then raise exception 'Call not found'; end if;
  if c.status = 'ringing' then
    update public.calls set status = case when c.caller = auth.uid() then 'cancelled' else 'declined' end, ended_at = now() where id = c.id;
  elsif c.status = 'active' then
    update public.calls set status = 'ended', ended_at = now() where id = c.id;
  end if;
end $$;

-- The edge function asks this before minting a LiveKit token: only the two people on a live call, and only while it can still be joined.
create or replace function public.call_token_gate(p_call uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.calls; p public.profiles;
begin
  if auth.uid() is null then raise exception 'Sign in' using errcode = '28000'; end if;
  select * into c from public.calls where id = p_call and (caller = auth.uid() or callee = auth.uid());
  if not found then raise exception 'Call not found'; end if;
  if c.status = 'ringing' and c.created_at < now() - interval '60 seconds' then raise exception 'This call has ended'; end if;
  if c.status not in ('ringing', 'active') then raise exception 'This call has ended'; end if;
  if c.status = 'ringing' and c.callee = auth.uid() then raise exception 'Answer the call first'; end if;
  select * into p from public.profiles where id = auth.uid();
  return jsonb_build_object('room', c.room, 'kind', c.kind, 'name', coalesce(nullif(p.display_name, ''), p.username),
                            'role', case when c.caller = auth.uid() then 'caller' else 'callee' end);
end $$;
revoke execute on function public.start_call(uuid, text), public.respond_call(uuid, boolean), public.end_call(uuid), public.call_token_gate(uuid) from public, anon;
grant execute on function public.start_call(uuid, text), public.respond_call(uuid, boolean), public.end_call(uuid), public.call_token_gate(uuid) to authenticated;

-- Realtime delivery (incoming calls, new messages, notifications). Skipped where the publication does not exist.
do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['calls', 'messages', 'notifications'] loop
      if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;
