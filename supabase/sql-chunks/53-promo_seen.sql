create table if not exists public.promo_seen (
  user_id uuid not null references public.profiles(id) on delete cascade,
  slide_id uuid not null references public.promo_slides(id) on delete cascade,
  day date not null default current_date,
  kind text not null check (kind in ('impression','click')),
  primary key (user_id, slide_id, day, kind)
);

create table if not exists public.promo_stats (
  slide_id uuid not null references public.promo_slides(id) on delete cascade,
  day date not null,
  impressions integer not null default 0,
  clicks integer not null default 0,
  primary key (slide_id, day)
);

alter table public.promo_slides enable row level security;

alter table public.promo_seen enable row level security;

alter table public.promo_stats enable row level security;

drop policy if exists promo_read on public.promo_slides;

create policy promo_read on public.promo_slides for select to authenticated
  using (public.is_admin() or (status = 'live' and starts_at <= now() and (ends_at is null or ends_at > now())));

drop policy if exists promo_write on public.promo_slides;

create policy promo_write on public.promo_slides for insert to authenticated with check (public.is_admin());

drop policy if exists promo_edit on public.promo_slides;

create policy promo_edit on public.promo_slides for update to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists promo_del on public.promo_slides;

create policy promo_del on public.promo_slides for delete to authenticated using (public.is_admin());

drop policy if exists promo_stats_read on public.promo_stats;

create policy promo_stats_read on public.promo_stats for select to authenticated using (public.is_admin());

revoke all on public.promo_slides, public.promo_seen, public.promo_stats from anon, authenticated;

grant select, delete on public.promo_slides to authenticated;

grant insert (advertiser, title, subtitle, cta_label, cta_url, media_type, media_path, poster_path, focal_x, focal_y, accent, sound, city, priority, status, starts_at, ends_at, created_by) on public.promo_slides to authenticated;

grant update (advertiser, title, subtitle, cta_label, cta_url, media_type, media_path, poster_path, focal_x, focal_y, accent, sound, city, priority, status, starts_at, ends_at, updated_at) on public.promo_slides to authenticated;

grant select on public.promo_stats to authenticated;

-- Promo media goes in the existing public `brand` bucket under promo/ (admins only), next to the sign-in hero.
drop policy if exists brand_admin_insert on storage.objects;

create policy brand_admin_insert on storage.objects for insert to authenticated
  with check (bucket_id in ('brand', 'brand-draft') and public.is_admin() and name ~ '^(hero|promo)/[0-9a-f-]{36}\.(jpg|png|webp|mp4|webm)$');
