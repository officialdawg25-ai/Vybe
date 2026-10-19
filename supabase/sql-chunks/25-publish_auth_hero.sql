-- Publishes the saved draft. Refuses unless its media is already present in the public bucket.
create or replace function public.publish_auth_hero() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare d jsonb; p text;
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  select draft into d from public.site_settings where key = 'auth_hero';
  if d is null then raise exception 'nothing to publish: save a draft first'; end if;
  d := public.validate_auth_hero(d);
  foreach p in array array[d->>'path', d->>'poster_path'] loop
    if p is not null and not exists (select 1 from storage.objects where bucket_id = 'brand' and name = p) then
      raise exception 'media % has not been copied to the public bucket', p;
    end if;
  end loop;
  update public.site_settings set published = d, published_by = auth.uid(), published_at = now() where key = 'auth_hero';
  insert into public.audit_log (actor, action, entity_type, detail) values (auth.uid(), 'auth_hero.published', 'site_settings', d);
  return d;
end $$;

-- Stops showing the custom hero (the built-in default is used); the draft is kept.
create or replace function public.unpublish_auth_hero() returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.site_settings set published = null, published_by = auth.uid(), published_at = now() where key = 'auth_hero';
  insert into public.audit_log (actor, action, entity_type) values (auth.uid(), 'auth_hero.unpublished', 'site_settings');
end $$;

-- Restores the approved default: clears both draft and published copies.
create or replace function public.reset_auth_hero() returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.site_settings set draft = null, published = null, updated_by = auth.uid(), updated_at = now(), published_at = now() where key = 'auth_hero';
  insert into public.audit_log (actor, action, entity_type) values (auth.uid(), 'auth_hero.reset', 'site_settings');
end $$;

revoke execute on function public.is_admin(), public.get_auth_hero(), public.save_auth_hero_draft(jsonb), public.publish_auth_hero(),
  public.unpublish_auth_hero(), public.reset_auth_hero(), public.validate_auth_hero(jsonb) from public, anon, authenticated;

grant execute on function public.get_auth_hero() to anon, authenticated;

grant execute on function public.is_admin(), public.save_auth_hero_draft(jsonb), public.publish_auth_hero(),
  public.unpublish_auth_hero(), public.reset_auth_hero() to authenticated;

-- ----------------------------------------------------------------- storage
-- `brand-draft` is private (admins only). `brand` is public-read so signed-out visitors can load the
-- published hero; only admins can write to it. Files are image/video only, 50 MB max.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('brand-draft', 'brand-draft', false, 52428800, array['image/jpeg','image/png','image/webp','video/mp4','video/webm']),
  ('brand', 'brand', true, 52428800, array['image/jpeg','image/png','image/webp','video/mp4','video/webm'])
on conflict (id) do update
  set public = excluded.public, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists brand_admin_select on storage.objects;

create policy brand_admin_select on storage.objects for select to authenticated
  using (bucket_id in ('brand', 'brand-draft') and public.is_admin());

drop policy if exists brand_admin_insert on storage.objects;
