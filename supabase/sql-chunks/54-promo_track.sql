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

create or replace function public.save_home_hero_settings(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v jsonb;
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  v := jsonb_build_object(
    'trending_enabled', coalesce((p->>'trending_enabled')::boolean, true),
    'max_trending', least(10, greatest(0, coalesce((p->>'max_trending')::int, 5))),
    'autoplay_ms', least(20000, greatest(3000, coalesce((p->>'autoplay_ms')::int, 7000))),
    'sponsored_every', least(6, greatest(2, coalesce((p->>'sponsored_every')::int, 3))));
  insert into public.site_settings (key, published, published_by, published_at, updated_by, updated_at) values ('home_hero', v, auth.uid(), now(), auth.uid(), now())
  on conflict (key) do update set published = excluded.published, published_by = excluded.published_by, published_at = excluded.published_at, updated_by = excluded.updated_by, updated_at = excluded.updated_at;
  insert into public.audit_log (actor, action, entity_type, detail) values (auth.uid(), 'home_hero.settings', 'site_settings', v);
  return v;
end $$;
