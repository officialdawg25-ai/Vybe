-- Run 01-storage-buckets.sql (storage/platform/brand hero set), in filename order. Re-runnable.
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

-- Opt-out per notification type; absent key = enabled. Security-relevant types would bypass this (none exist yet).
create or replace function public.notify(uid uuid, t text, actor uuid, etype text, eid uuid, dkey text) returns void
language plpgsql security definer set search_path = '' as $$
declare allowed boolean;
begin
  if uid is null or uid = actor then return; end if;
  select coalesce((notif_prefs ->> t)::boolean, true) into allowed from public.profiles where id = uid;
  if allowed is distinct from true then return; end if;
  insert into public.notifications (user_id, type, actor_id, entity_type, entity_id, dedupe_key)
  values (uid, t, actor, etype, eid, dkey)
  on conflict (user_id, dedupe_key) do nothing;
end $$;

-- ------------------------------------------------------------ organizations
-- An organization is a separate identity from its members. Membership grants
-- publishing rights for the organization only, never access to members' private data.
create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 2 and 80),
  slug text not null check (slug ~ '^[a-z0-9-]{3,40}$'),
  kind text not null check (kind in ('organizer','venue','business','creator','brand')),
  description text not null default '' check (char_length(description) <= 1000),
  avatar_path text,
  verified_at timestamptz,            -- set by staff via service role only
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now()
);

create unique index if not exists organizations_slug_key on public.organizations (lower(slug));
