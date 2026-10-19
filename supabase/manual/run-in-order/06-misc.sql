-- Run 06-misc.sql (storage/platform/brand hero set), in filename order. Re-runnable.
-- Brand & Experience: administrator-managed authentication hero (image or video).
--
-- * One settings row ('auth_hero') holds a private `draft` and the public `published` copy.
-- * Admins write only through the RPCs below (no table write grants). Anyone, including
--   signed-out visitors, can read the *published* copy through get_auth_hero().
-- * Uploads go to the private `brand-draft` bucket; publishing copies them into the public
--   `brand` bucket, and publish refuses unless every referenced file is already there, so a
--   failed copy can never replace the last valid hero.
-- Admin = a row in public.staff with role 'admin' (moderators are not admins).

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.staff where user_id = auth.uid() and role = 'admin');
$$;

create table if not exists public.site_settings (
  key text primary key check (key in ('auth_hero')),
  draft jsonb,
  published jsonb,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  published_by uuid references auth.users(id) on delete set null,
  published_at timestamptz
);

alter table public.site_settings enable row level security;

drop policy if exists site_settings_admin_select on public.site_settings;

create policy site_settings_admin_select on public.site_settings for select to authenticated using (public.is_admin());

revoke all on public.site_settings from anon, authenticated;

grant select on public.site_settings to authenticated;

-- Normalises and validates a hero configuration; raises on anything malformed.
create or replace function public.validate_auth_hero(cfg jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare
  mt text := nullif(cfg->>'media_type', '');
  mp text := nullif(cfg->>'path', '');
  pp text := nullif(cfg->>'poster_path', '');
  fx numeric := coalesce((cfg->>'focal_x')::numeric, 50);
  fy numeric := coalesce((cfg->>'focal_y')::numeric, 50);
  ov numeric := coalesce((cfg->>'overlay')::numeric, 45);
  hl text := coalesce(cfg->>'headline', '');
  bd text := coalesce(cfg->>'body', '');
begin
  if jsonb_typeof(cfg) is distinct from 'object' then raise exception 'invalid hero configuration'; end if;
  if mt is not null and mt not in ('image', 'video') then raise exception 'media_type must be image or video'; end if;
  if (mt is null) <> (mp is null) then raise exception 'media_type and path must be set together'; end if;
  if mp is not null and mp !~ '^hero/[0-9a-f-]{36}\.(jpg|png|webp|mp4|webm)$' then raise exception 'invalid media path'; end if;
  if mt = 'image' and mp !~ '\.(jpg|png|webp)$' then raise exception 'image path must be jpg, png or webp'; end if;
  if mt = 'video' and mp !~ '\.(mp4|webm)$' then raise exception 'video path must be mp4 or webm'; end if;
  if pp is not null and (mt is distinct from 'video' or pp !~ '^hero/[0-9a-f-]{36}\.(jpg|png|webp)$') then raise exception 'invalid poster path'; end if;
  if fx < 0 or fx > 100 or fy < 0 or fy > 100 then raise exception 'focal point must be between 0 and 100'; end if;
  if ov < 0 or ov > 80 then raise exception 'overlay must be between 0 and 80'; end if;
  if char_length(hl) > 120 then raise exception 'headline is limited to 120 characters'; end if;
  if char_length(bd) > 300 then raise exception 'supporting text is limited to 300 characters'; end if;
  return jsonb_strip_nulls(jsonb_build_object(
    'media_type', mt, 'path', mp, 'poster_path', pp,
    'focal_x', fx, 'focal_y', fy, 'overlay', ov, 'headline', hl, 'body', bd));
end $$;

-- Public read: the published hero only (null when nothing is published).
create or replace function public.get_auth_hero() returns jsonb
language sql stable security definer set search_path = '' as $$
  select s.published || jsonb_build_object('published_at', s.published_at)
  from public.site_settings s where s.key = 'auth_hero' and s.published is not null;
$$;
