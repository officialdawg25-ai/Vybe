-- 16: one campaign engine for two placements (Home billboard, Discover hero), honest labels, and organisation submissions.
--
--  * promo_slides gains placements (home and/or discover), a kind (sponsored | house | announcement) so VYBE's own promotions
--    are never labelled as paid, and an owning organisation for campaigns that organisations submit.
--  * State machine, enforced in the database (a client cannot make a campaign live by editing a field):
--      organisation owner/admin:  draft ⇄ submitted   (may edit, resubmit after a rejection, or delete their own until approved)
--      platform admin:            submitted → live (approved; "scheduled" while before starts_at) | rejected (with a reason)
--                                 live ⇄ paused, and anything else on platform-owned rows
--    Organisation rows are always "Sponsored", carry the organisation's own name as the advertiser, and their priority is set
--    by the admin who approves them. Reviews are written to audit_log and notify the organisation's owners and admins.
--  * Organisations upload creatives to brand/promo/o-<organisation id>/…; platform media stays under brand/promo/.
-- Additive: existing slides keep working (placements default to Home only, kind defaults to sponsored, no owner).
-- Rollback: drop the trigger/functions/policies below, then the added columns; restore the two original check constraints.

alter table public.promo_slides add column if not exists placements text[] not null default '{home}';
alter table public.promo_slides add column if not exists kind text not null default 'sponsored';
alter table public.promo_slides add column if not exists organization_id uuid references public.organizations(id) on delete cascade;
alter table public.promo_slides add column if not exists review_note text;
alter table public.promo_slides add column if not exists submitted_at timestamptz;
alter table public.promo_slides add column if not exists reviewed_by uuid references public.profiles(id) on delete set null;
alter table public.promo_slides add column if not exists reviewed_at timestamptz;

alter table public.promo_slides drop constraint if exists promo_slides_placements_check;
alter table public.promo_slides add constraint promo_slides_placements_check
  check (cardinality(placements) between 1 and 2 and placements <@ array['home','discover']::text[]);
alter table public.promo_slides drop constraint if exists promo_slides_kind_check;
alter table public.promo_slides add constraint promo_slides_kind_check check (kind in ('sponsored','house','announcement'));
alter table public.promo_slides drop constraint if exists promo_slides_review_note_check;
alter table public.promo_slides add constraint promo_slides_review_note_check check (review_note is null or char_length(review_note) <= 300);
alter table public.promo_slides drop constraint if exists promo_slides_status_check;
alter table public.promo_slides add constraint promo_slides_status_check check (status in ('draft','submitted','rejected','live','paused'));
alter table public.promo_slides drop constraint if exists promo_slides_media_path_check;
alter table public.promo_slides add constraint promo_slides_media_path_check
  check (media_path ~ '^promo/(o-[0-9a-f-]{36}/)?[0-9a-f-]{36}\.(jpg|png|webp|mp4|webm)$');
alter table public.promo_slides drop constraint if exists promo_slides_org_kind;
alter table public.promo_slides add constraint promo_slides_org_kind check (organization_id is null or kind = 'sponsored');
alter table public.promo_slides drop constraint if exists promo_slides_org_media;
alter table public.promo_slides add constraint promo_slides_org_media
  check (organization_id is null or media_path is null or media_path like 'promo/o-' || organization_id::text || '/%');
create index if not exists promo_slides_org_idx on public.promo_slides (organization_id) where organization_id is not null;
create index if not exists promo_slides_review_idx on public.promo_slides (status) where status = 'submitted';

-- True when the caller may manage campaigns for the organisation (owner or admin, active membership).
create or replace function public.can_manage_campaigns(oid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select oid is not null and coalesce(public.org_role(oid) in ('owner','admin'), false);
$$;
revoke execute on function public.can_manage_campaigns(uuid) from public, anon;
grant execute on function public.can_manage_campaigns(uuid) to authenticated;

-- Members: live slides only (unchanged). Organisation managers: also every slide their organisation owns, at any stage.
drop policy if exists promo_read on public.promo_slides;
create policy promo_read on public.promo_slides for select to authenticated
  using (public.is_admin() or (status = 'live' and starts_at <= now() and (ends_at is null or ends_at > now()))
         or public.can_manage_campaigns(organization_id));
drop policy if exists promo_write on public.promo_slides;
create policy promo_write on public.promo_slides for insert to authenticated
  with check (public.is_admin() or (public.can_manage_campaigns(organization_id) and status in ('draft','submitted')));
drop policy if exists promo_edit on public.promo_slides;
create policy promo_edit on public.promo_slides for update to authenticated
  using (public.is_admin() or (public.can_manage_campaigns(organization_id) and status in ('draft','submitted','rejected')))
  with check (public.is_admin() or (public.can_manage_campaigns(organization_id) and status in ('draft','submitted')));
drop policy if exists promo_del on public.promo_slides;
create policy promo_del on public.promo_slides for delete to authenticated
  using (public.is_admin() or (public.can_manage_campaigns(organization_id) and status in ('draft','submitted','rejected')));

grant insert (placements, kind, organization_id) on public.promo_slides to authenticated;
grant update (placements, kind, review_note) on public.promo_slides to authenticated;
-- review_note is written by admins only (the trigger keeps the old value for anyone else); submitted_at, reviewed_by and
-- reviewed_at are only ever set by the trigger, and organization_id cannot change after insert.

-- Organisation managers may read their own campaign statistics.
drop policy if exists promo_stats_read on public.promo_stats;
create policy promo_stats_read on public.promo_stats for select to authenticated
  using (public.is_admin() or exists (select 1 from public.promo_slides s where s.id = slide_id and public.can_manage_campaigns(s.organization_id)));

create or replace function public.promo_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare admin boolean := public.is_admin(); org_name text;
begin
  if auth.uid() is null then return new; end if;                       -- server-side maintenance
  if tg_op = 'UPDATE' and new.organization_id is distinct from old.organization_id then
    raise exception 'A campaign cannot move to another organisation.' using errcode = '42501';
  end if;
  if new.organization_id is not null then
    select name into org_name from public.organizations where id = new.organization_id;
    new.advertiser := left(coalesce(org_name, ''), 80);                  -- the organisation can only advertise as itself
    new.kind := 'sponsored';
  end if;
  if not admin then
    if new.status not in ('draft','submitted') then
      raise exception 'Only VYBE can approve, publish, pause or reject a campaign.' using errcode = '42501';
    end if;
    new.priority := case when tg_op = 'UPDATE' then old.priority else 50 end;
    if tg_op = 'UPDATE' then new.review_note := old.review_note; new.reviewed_by := old.reviewed_by; new.reviewed_at := old.reviewed_at; end if;
    if new.status = 'submitted' and (tg_op = 'INSERT' or old.status is distinct from 'submitted') then new.submitted_at := now(); end if;
  else
    if tg_op = 'UPDATE' and new.status is distinct from old.status and new.status in ('live','rejected') and old.status in ('submitted','draft','rejected') then
      new.reviewed_by := auth.uid(); new.reviewed_at := now();
      if new.status = 'rejected' and coalesce(btrim(new.review_note), '') = '' then
        raise exception 'Give the organisation a reason when rejecting a campaign.' using errcode = '23514';
      end if;
      if new.status = 'live' then new.review_note := null; end if;
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$;
revoke execute on function public.promo_guard() from public, anon, authenticated;
drop trigger if exists trg_promo_guard on public.promo_slides;
create trigger trg_promo_guard before insert or update on public.promo_slides for each row execute function public.promo_guard();

-- Reviews and state changes are audited; the organisation's owners and admins hear about approvals and rejections.
alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check check (type in
  ('friend_request', 'friend_accepted', 'reaction', 'comment', 'event_invite', 'rsvp', 'community_join', 'new_event', 'event_update', 'event_cancelled', 'live_started',
   'post_tag', 'memory_reaction', 'memory_reply', 'verified', 'security', 'campaign'));

create or replace function public.promo_audit() returns trigger
language plpgsql security definer set search_path = '' as $$
declare m record;
begin
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    insert into public.audit_log (actor, action, entity_type, entity_id, detail)
    values (auth.uid(), 'campaign.' || new.status, 'promo_slides', new.id,
            jsonb_build_object('from', case when tg_op = 'UPDATE' then old.status end, 'organization_id', new.organization_id, 'note', new.review_note));
    if tg_op = 'UPDATE' and new.organization_id is not null and new.status in ('live','rejected') and old.status in ('submitted','draft','rejected') then
      for m in select user_id from public.organization_members where organization_id = new.organization_id and status = 'active' and role in ('owner','admin') loop
        perform public.notify(m.user_id, 'campaign', auth.uid(), 'campaign', new.id, 'campaign:' || new.id || ':' || new.status || ':' || extract(epoch from now())::bigint);
      end loop;
    end if;
  end if;
  return null;
end $$;
revoke execute on function public.promo_audit() from public, anon, authenticated;
drop trigger if exists trg_promo_audit on public.promo_slides;
create trigger trg_promo_audit after insert or update on public.promo_slides for each row execute function public.promo_audit();

-- Creative uploads: platform admins under promo/, organisation managers under promo/o-<their organisation>/.
drop policy if exists brand_admin_insert on storage.objects;
create policy brand_admin_insert on storage.objects for insert to authenticated
  with check (
    (bucket_id in ('brand', 'brand-draft') and public.is_admin() and name ~ '^(hero|promo)/[0-9a-f-]{36}\.(jpg|png|webp|mp4|webm)$')
    or (bucket_id = 'brand' and name ~ '^promo/o-[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|png|webp|mp4|webm)$'
        and public.can_manage_campaigns(substring(name from '^promo/o-([0-9a-f-]{36})/')::uuid)));
drop policy if exists brand_org_delete on storage.objects;
create policy brand_org_delete on storage.objects for delete to authenticated
  using (bucket_id = 'brand' and name ~ '^promo/o-[0-9a-f-]{36}/'
         and public.can_manage_campaigns(substring(name from '^promo/o-([0-9a-f-]{36})/')::uuid));
