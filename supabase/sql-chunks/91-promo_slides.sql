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
