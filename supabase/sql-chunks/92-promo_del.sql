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
