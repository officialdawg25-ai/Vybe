create trigger event_source_guard before insert or update on public.events for each row execute function public.trg_event_source_guard();

-- Drafts are visible to the host and the organization's editors only.
create or replace function public.can_view_event(e public.events) returns boolean
language sql stable security definer set search_path = '' as $$
  select e.host = auth.uid()
    or (e.organization_id is not null and public.org_role(e.organization_id) in ('owner', 'admin', 'editor'))
    or (e.status <> 'draft' and not public.is_blocked(auth.uid(), e.host) and (
      public.is_invited(e.id)
      or (e.visibility = 'public' and (e.community_id is null or public.community_is_public(e.community_id) or public.is_community_member(e.community_id)))
      or (e.visibility = 'friends' and public.are_friends(auth.uid(), e.host))
    ));
$$;

-- Artists are organizations too.
alter table public.organizations drop constraint if exists organizations_kind_check;

alter table public.organizations add constraint organizations_kind_check check (kind in ('organizer', 'venue', 'business', 'creator', 'brand', 'artist'));

-- ---------------------------------------------------------------- RSVP privacy
alter table public.event_rsvps add column if not exists visibility text not null default 'friends' check (visibility in ('public', 'friends', 'private'));

grant update (visibility) on public.event_rsvps to authenticated;

drop policy if exists rsvps_select on public.event_rsvps;

create policy rsvps_select on public.event_rsvps for select to authenticated
  using (user_id = auth.uid() or public.can_manage_event(event_id)
    or (public.can_view_event_id(event_id) and not public.is_blocked(auth.uid(), user_id)
        and (visibility = 'public' or (visibility = 'friends' and public.are_friends(auth.uid(), user_id)))));

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
