-- 04-event_lineup.sql: run in filename order (voice notes, onboarding data, events near you, tickets). Re-runnable.
-- ------------------------------------------------------------ lineup (artists, guests, hosts)
create table if not exists public.event_lineup (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  role text not null default 'Guest' check (char_length(role) between 1 and 40),
  bio text not null default '' check (char_length(bio) <= 300),
  image_path text,
  sort integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists event_lineup_event_idx on public.event_lineup (event_id, sort);

alter table public.event_lineup enable row level security;

drop policy if exists lineup_select on public.event_lineup;

create policy lineup_select on public.event_lineup for select to authenticated using (public.can_view_event_id(event_id));

drop policy if exists lineup_insert on public.event_lineup;

create policy lineup_insert on public.event_lineup for insert to authenticated with check (public.can_manage_event(event_id));

drop policy if exists lineup_update on public.event_lineup;

create policy lineup_update on public.event_lineup for update to authenticated using (public.can_manage_event(event_id)) with check (public.can_manage_event(event_id));

drop policy if exists lineup_delete on public.event_lineup;

create policy lineup_delete on public.event_lineup for delete to authenticated using (public.can_manage_event(event_id));

revoke all on public.event_lineup from anon, authenticated;

grant select, delete on public.event_lineup to authenticated;

grant insert (event_id, name, role, bio, image_path, sort) on public.event_lineup to authenticated;

grant update (name, role, bio, image_path, sort) on public.event_lineup to authenticated;

-- Lineup photos are visible wherever the event is.
drop policy if exists media_select_visible on storage.objects;

create policy media_select_visible on storage.objects for select to authenticated
  using (
    bucket_id = 'media' and (
      (storage.foldername(name))[1] = auth.uid()::text
      or exists (select 1 from public.posts p where p.media_path = name)
      or exists (select 1 from public.comments c where c.audio_path = name)
      or exists (select 1 from public.profiles pr where pr.avatar_path = name)
      or exists (select 1 from public.events e where e.cover_path = name)
      or exists (select 1 from public.event_lineup l where l.image_path = name)
      or exists (select 1 from public.communities c where c.cover_path = name)
    )
  );
