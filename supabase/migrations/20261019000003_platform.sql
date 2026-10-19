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

create table if not exists public.organization_members (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null check (role in ('owner','admin','editor')),
  status text not null default 'invited' check (status in ('invited','active')),
  created_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);
create index if not exists organization_members_user_idx on public.organization_members (user_id);

create or replace function public.org_role(oid uuid) returns text
language sql stable security definer set search_path = '' as $$
  select role from public.organization_members
  where organization_id = oid and user_id = auth.uid() and status = 'active';
$$;

alter table public.events add column if not exists organization_id uuid references public.organizations(id) on delete set null;
create index if not exists events_org_idx on public.events (organization_id);

alter table public.organizations enable row level security;
alter table public.organization_members enable row level security;

drop policy if exists orgs_select on public.organizations;
create policy orgs_select on public.organizations for select to authenticated using (true);
drop policy if exists orgs_insert on public.organizations;
create policy orgs_insert on public.organizations for insert to authenticated
  with check (created_by = auth.uid() and verified_at is null);
drop policy if exists orgs_update on public.organizations;
create policy orgs_update on public.organizations for update to authenticated
  using (public.org_role(id) in ('owner','admin')) with check (public.org_role(id) in ('owner','admin'));
drop policy if exists orgs_delete on public.organizations;
create policy orgs_delete on public.organizations for delete to authenticated using (public.org_role(id) = 'owner');

drop policy if exists om_select on public.organization_members;
create policy om_select on public.organization_members for select to authenticated
  using (user_id = auth.uid() or public.org_role(organization_id) is not null);
drop policy if exists om_invite on public.organization_members;
create policy om_invite on public.organization_members for insert to authenticated
  with check (public.org_role(organization_id) in ('owner','admin') and status = 'invited' and role in ('admin','editor') and user_id <> auth.uid()
              and not public.is_blocked(auth.uid(), user_id));
-- An invitee accepts their own invitation (and nothing else about it).
drop policy if exists om_accept on public.organization_members;
create policy om_accept on public.organization_members for update to authenticated
  using (user_id = auth.uid() and status = 'invited') with check (user_id = auth.uid() and status = 'active');
drop policy if exists om_remove on public.organization_members;
create policy om_remove on public.organization_members for delete to authenticated
  using ((user_id = auth.uid() and role <> 'owner') or (public.org_role(organization_id) in ('owner','admin') and role <> 'owner'));

revoke all on public.organizations, public.organization_members from anon, authenticated;
grant select on public.organizations, public.organization_members to authenticated;
grant insert (name, slug, kind, description, avatar_path, created_by) on public.organizations to authenticated;
grant update (name, description, avatar_path) on public.organizations to authenticated;
grant delete on public.organizations to authenticated;
grant insert (organization_id, user_id, role, status) on public.organization_members to authenticated;
grant update (status) on public.organization_members to authenticated;
grant delete on public.organization_members to authenticated;

create or replace function public.trg_org_owner() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.organization_members (organization_id, user_id, role, status) values (new.id, new.created_by, 'owner', 'active');
  return new;
end $$;
drop trigger if exists org_owner on public.organizations;
create trigger org_owner after insert on public.organizations for each row execute function public.trg_org_owner();

-- Events may be hosted on behalf of an organization the user actively belongs to.
drop policy if exists events_insert on public.events;
drop policy if exists events_insert on public.events;
create policy events_insert on public.events for insert to authenticated
  with check (
    host = auth.uid()
    and (community_id is null or public.is_community_member(community_id))
    and (organization_id is null or public.org_role(organization_id) in ('owner','admin','editor'))
  );
drop policy if exists events_org_update on public.events;
create policy events_org_update on public.events for update to authenticated
  using (organization_id is not null and public.org_role(organization_id) in ('owner','admin','editor'))
  with check (organization_id is not null and public.org_role(organization_id) in ('owner','admin','editor'));
grant insert (organization_id) on public.events to authenticated;

-- ------------------------------------------------ entitlements (no payments here)
-- Subscriptions are written only by a verified payment-provider webhook running with the
-- service role (which bypasses RLS). Clients can read their own and nothing else.
create table if not exists public.plans (
  id text primary key,
  features text[] not null default '{}'
);
create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete cascade,
  organization_id uuid references public.organizations(id) on delete cascade,
  plan_id text not null references public.plans(id),
  status text not null check (status in ('trialing','active','past_due','canceled')),
  provider text not null,
  provider_ref text not null,
  current_period_end timestamptz,
  created_at timestamptz not null default now(),
  check ((user_id is null) <> (organization_id is null)),
  unique (provider, provider_ref)
);
-- Webhook idempotency ledger: one row per provider event id. No client access.
create table if not exists public.provider_events (
  provider text not null,
  event_id text not null,
  received_at timestamptz not null default now(),
  primary key (provider, event_id)
);
alter table public.plans enable row level security;
alter table public.subscriptions enable row level security;
alter table public.provider_events enable row level security;
drop policy if exists plans_select on public.plans;
create policy plans_select on public.plans for select to authenticated using (true);
drop policy if exists subs_select on public.subscriptions;
create policy subs_select on public.subscriptions for select to authenticated
  using (user_id = auth.uid() or public.org_role(organization_id) in ('owner','admin'));
revoke all on public.plans, public.subscriptions, public.provider_events from anon, authenticated;
grant select on public.plans, public.subscriptions to authenticated;

-- Server-side check for gated capabilities; never trust a client claim.
create or replace function public.has_feature(feature text, org uuid default null) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.subscriptions s join public.plans p on p.id = s.plan_id
    where s.status in ('active','trialing') and (s.current_period_end is null or s.current_period_end > now())
      and feature = any (p.features)
      and ((org is null and s.user_id = auth.uid())
        or (org is not null and s.organization_id = org and public.org_role(org) in ('owner','admin')))
  );
$$;

-- --------------------------------------------------------- live scheduling
-- Streaming itself is provider-hosted (LiveKit); this table is the app-side record.
-- Transitions to 'live'/'ended' are performed only by a server holding provider credentials.
create table if not exists public.live_streams (
  id uuid primary key default gen_random_uuid(),
  host uuid not null references public.profiles(id) on delete cascade,
  organization_id uuid references public.organizations(id) on delete set null,
  event_id uuid references public.events(id) on delete set null,
  title text not null check (char_length(title) between 2 and 120),
  status text not null default 'scheduled' check (status in ('scheduled','live','ended','cancelled')),
  visibility text not null default 'public' check (visibility in ('public','friends')),
  scheduled_for timestamptz,
  provider text not null default 'livekit',
  room text not null default gen_random_uuid()::text,
  recording_consent boolean not null default false,
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  unique (room)
);
create index if not exists live_streams_status_idx on public.live_streams (status, scheduled_for);
alter table public.live_streams enable row level security;
drop policy if exists live_select on public.live_streams;
create policy live_select on public.live_streams for select to authenticated
  using (host = auth.uid() or (not public.is_blocked(auth.uid(), host)
    and (visibility = 'public' or (visibility = 'friends' and public.are_friends(auth.uid(), host)))));
drop policy if exists live_insert on public.live_streams;
create policy live_insert on public.live_streams for insert to authenticated
  with check (host = auth.uid() and status = 'scheduled'
    and (organization_id is null or public.org_role(organization_id) in ('owner','admin','editor')));
drop policy if exists live_update on public.live_streams;
create policy live_update on public.live_streams for update to authenticated
  using (host = auth.uid() and status = 'scheduled') with check (host = auth.uid() and status in ('scheduled','cancelled'));
drop policy if exists live_delete on public.live_streams;
create policy live_delete on public.live_streams for delete to authenticated using (host = auth.uid() and status in ('scheduled','cancelled'));
revoke all on public.live_streams from anon, authenticated;
grant select on public.live_streams to authenticated;
grant insert (host, organization_id, event_id, title, visibility, scheduled_for, recording_consent) on public.live_streams to authenticated;
grant update (title, visibility, scheduled_for, status, recording_consent) on public.live_streams to authenticated;
grant delete on public.live_streams to authenticated;

-- Streams can be reported like any other entity.
do $$ begin
  alter table public.reports drop constraint if exists reports_entity_type_check;
  alter table public.reports add constraint reports_entity_type_check
    check (entity_type in ('profile','post','comment','message','community','event','stream'));
end $$;

-- ------------------------------------------------- staff moderation (RPC only)
-- Staff never get blanket table access. They see only the reported item, via an audited RPC.
create or replace function public.staff_report_context(rid uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.reports; ctx jsonb;
begin
  if not public.is_staff() then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into r from public.reports where id = rid;
  if not found then raise exception 'report not found'; end if;
  ctx := case r.entity_type
    when 'post' then (select jsonb_build_object('text', body, 'author', author, 'media', media_path is not null) from public.posts where id = r.entity_id)
    when 'comment' then (select jsonb_build_object('text', body, 'author', author) from public.comments where id = r.entity_id)
    when 'message' then (select jsonb_build_object('text', body, 'author', sender) from public.messages where id = r.entity_id)
    when 'event' then (select jsonb_build_object('text', title || E'\n' || description, 'author', host) from public.events where id = r.entity_id)
    when 'community' then (select jsonb_build_object('text', name || E'\n' || description, 'author', created_by) from public.communities where id = r.entity_id)
    when 'profile' then (select jsonb_build_object('text', username || E'\n' || display_name || E'\n' || bio, 'author', id) from public.profiles where id = r.entity_id)
    when 'stream' then (select jsonb_build_object('text', title, 'author', host) from public.live_streams where id = r.entity_id)
  end;
  insert into public.audit_log (actor, action, entity_type, entity_id, detail)
  values (auth.uid(), 'report.context_viewed', r.entity_type, r.entity_id, jsonb_build_object('report', rid));
  return coalesce(ctx, jsonb_build_object('text', null, 'gone', true));
end $$;

create or replace function public.staff_remove_content(rid uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.reports;
begin
  if not public.is_staff() then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into r from public.reports where id = rid;
  if not found then raise exception 'report not found'; end if;
  case r.entity_type
    when 'post' then delete from public.posts where id = r.entity_id;
    when 'comment' then delete from public.comments where id = r.entity_id;
    when 'event' then update public.events set status = 'cancelled' where id = r.entity_id;
    when 'community' then delete from public.communities where id = r.entity_id;
    when 'stream' then update public.live_streams set status = 'cancelled' where id = r.entity_id and status = 'scheduled';
    when 'message' then update public.messages set body = 'Message removed', deleted_at = now() where id = r.entity_id;
    else raise exception 'this content type cannot be removed from here';
  end case;
  update public.reports set status = 'actioned' where id = rid;
  insert into public.audit_log (actor, action, entity_type, entity_id, detail)
  values (auth.uid(), 'content.removed', r.entity_type, r.entity_id, jsonb_build_object('report', rid));
end $$;

revoke execute on function public.staff_report_context(uuid), public.staff_remove_content(uuid) from public, anon;
grant execute on function public.staff_report_context(uuid), public.staff_remove_content(uuid) to authenticated;
