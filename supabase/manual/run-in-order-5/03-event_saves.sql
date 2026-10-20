-- ---------------------------------------------------------------- saved events (a bookmark is not attendance)
create table if not exists public.event_saves (
  user_id uuid not null references public.profiles(id) on delete cascade,
  event_id uuid not null references public.events(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, event_id)
);

alter table public.event_saves enable row level security;

drop policy if exists event_saves_own on public.event_saves;

create policy event_saves_own on public.event_saves for select to authenticated using (user_id = auth.uid());

drop policy if exists event_saves_ins on public.event_saves;

create policy event_saves_ins on public.event_saves for insert to authenticated with check (user_id = auth.uid() and public.can_view_event_id(event_id));

drop policy if exists event_saves_del on public.event_saves;

create policy event_saves_del on public.event_saves for delete to authenticated using (user_id = auth.uid());

revoke all on public.event_saves from anon, authenticated;

grant select, insert, delete on public.event_saves to authenticated;

-- ---------------------------------------------------------------- follows
create table if not exists public.follows (
  follower uuid not null references public.profiles(id) on delete cascade,
  target_type text not null check (target_type in ('profile', 'organization')),
  target_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (follower, target_type, target_id),
  check (target_type <> 'profile' or target_id <> follower)
);

create index if not exists follows_target_idx on public.follows (target_type, target_id);

alter table public.follows enable row level security;

drop policy if exists follows_own_read on public.follows;

create policy follows_own_read on public.follows for select to authenticated using (follower = auth.uid());

drop policy if exists follows_own_ins on public.follows;

create policy follows_own_ins on public.follows for insert to authenticated with check (follower = auth.uid());

drop policy if exists follows_own_del on public.follows;

create policy follows_own_del on public.follows for delete to authenticated using (follower = auth.uid());

revoke all on public.follows from anon, authenticated;

grant select, insert, delete on public.follows to authenticated;
