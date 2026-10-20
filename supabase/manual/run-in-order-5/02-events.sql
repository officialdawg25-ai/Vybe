-- External listings can only be written by trusted server code (service role); browsers cannot claim a provider identity.
alter table public.events drop constraint if exists events_external_has_source;

alter table public.events add constraint events_external_has_source check (source = 'vybe' or (source_name is not null and source_url is not null));

create index if not exists events_discover_idx on public.events (status, visibility, starts_at);

create index if not exists events_category_idx on public.events (category) where category is not null;

grant insert (category, format, online_url, status) on public.events to authenticated;

grant update (category, format, online_url, status) on public.events to authenticated;

-- Table-level grants cover these columns, so a trigger (not a column revoke) keeps provider identity server-side only.
create or replace function public.trg_event_source_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if auth.uid() is not null and (new.source <> 'vybe' or new.source_name is not null or new.source_url is not null)
     and (tg_op = 'INSERT' or (new.source, new.source_name, new.source_url) is distinct from (old.source, old.source_name, old.source_url)) then
    raise exception 'External listings can only be created by VYBE servers' using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists event_source_guard on public.events;

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
