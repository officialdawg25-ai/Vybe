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

-- Counts one impression / one click per member per slide per day. Rate limited; returns whether it counted.
create or replace function public.promo_track(p_slide uuid, p_kind text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare counted integer;
begin
  if auth.uid() is null then raise exception 'Sign in' using errcode = '28000'; end if;
  if p_kind not in ('impression','click') then raise exception 'bad kind'; end if;
  if not exists (select 1 from public.promo_slides s where s.id = p_slide and s.status = 'live' and s.starts_at <= now() and (s.ends_at is null or s.ends_at > now())) then return false; end if;
  if (select count(*) from public.promo_seen where user_id = auth.uid() and day = current_date) >= 400 then return false; end if;
  insert into public.promo_seen (user_id, slide_id, kind) values (auth.uid(), p_slide, p_kind) on conflict do nothing;
  get diagnostics counted = row_count;
  if counted = 0 then return false; end if;
  insert into public.promo_stats (slide_id, day, impressions, clicks) values (p_slide, current_date, (p_kind = 'impression')::int, (p_kind = 'click')::int)
  on conflict (slide_id, day) do update set impressions = public.promo_stats.impressions + (p_kind = 'impression')::int, clicks = public.promo_stats.clicks + (p_kind = 'click')::int;
  return true;
end $$;

-- Billboard behaviour (admin editable). Members read the merged defaults through home_hero_settings().
create or replace function public.home_hero_settings() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('trending_enabled', true, 'max_trending', 5, 'autoplay_ms', 7000, 'sponsored_every', 3)
         || coalesce((select published from public.site_settings where key = 'home_hero'), '{}'::jsonb);
$$;
