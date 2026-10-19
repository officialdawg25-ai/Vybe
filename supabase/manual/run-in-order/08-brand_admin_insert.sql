-- Run 08-brand_admin_insert.sql (storage/platform/brand hero set), in filename order. Re-runnable.
create policy brand_admin_insert on storage.objects for insert to authenticated
  with check (bucket_id in ('brand', 'brand-draft') and public.is_admin() and name ~ '^hero/[0-9a-f-]{36}\.(jpg|png|webp|mp4|webm)$');

drop policy if exists brand_admin_delete on storage.objects;

create policy brand_admin_delete on storage.objects for delete to authenticated
  using (bucket_id in ('brand', 'brand-draft') and public.is_admin());
