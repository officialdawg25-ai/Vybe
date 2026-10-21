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

-- 17: profile privacy. Until now any signed-in member could read every column of every (unblocked) profile, including
-- city-centre coordinates (lat/lng), notification settings, onboarding answers (intents, step), country and the onboarding
-- and name-change timestamps. Those are now readable only by their owner (through my_profile()) and by security-definer
-- functions that already need them (discovery distance, notifications). Row-level rules are unchanged.
--
-- Public columns (unchanged for everyone): id, username, display_name, bio, avatar_path, location, interests, dm_policy,
-- created_at, cover_path, verified_until, follow_policy, show_followers.
-- Rollback: grant select on public.profiles to authenticated;

revoke select on public.profiles from authenticated, anon;

grant select (id, username, display_name, bio, avatar_path, location, interests, dm_policy, created_at, cover_path, verified_until, follow_policy, show_followers)
  on public.profiles to authenticated;

-- Your own full profile row (all columns), for the app's session and the data export.
create or replace function public.my_profile() returns jsonb
language sql stable security definer set search_path = '' as $$
  select to_jsonb(p) from public.profiles p where p.id = auth.uid();
$$;

revoke execute on function public.my_profile() from public, anon;

grant execute on function public.my_profile() to authenticated;
