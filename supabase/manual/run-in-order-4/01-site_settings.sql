-- Home billboard: admin-managed promo slides (commercial placements) + auto-selected trending events.
--   * Slides are plain rows managed by administrators only; members can read only slides that are live right now.
--   * Impressions/clicks are counted once per member per slide per day, as aggregate counters (no per-person ad history is exposed).
--   * "Trending" is a defined formula over real activity, computed in SQL and always limited to events the viewer may see.
-- Additive and re-runnable.

-- Settings row for the billboard lives next to the auth hero.
alter table public.site_settings drop constraint if exists site_settings_key_check;

alter table public.site_settings add constraint site_settings_key_check check (key in ('auth_hero', 'home_hero'));

create table if not exists public.promo_slides (
  id uuid primary key default gen_random_uuid(),
  advertiser text not null default '' check (char_length(advertiser) <= 80),
  title text not null check (char_length(title) between 2 and 90),
  subtitle text not null default '' check (char_length(subtitle) <= 160),
  cta_label text not null default 'Learn more' check (char_length(cta_label) between 1 and 24),
  cta_url text not null check (cta_url ~ '^(/app/[A-Za-z0-9/_?=&.%-]*|https://[^\s]+)$' and char_length(cta_url) <= 500),
  media_type text check (media_type in ('image','video')),
  media_path text check (media_path ~ '^promo/[0-9a-f-]{36}\.(jpg|png|webp|mp4|webm)$'),
  poster_path text check (poster_path ~ '^promo/[0-9a-f-]{36}\.(jpg|png|webp)$'),
  focal_x integer not null default 50 check (focal_x between 0 and 100),
  focal_y integer not null default 50 check (focal_y between 0 and 100),
  accent text not null default '#6a4cff' check (accent ~ '^#[0-9a-fA-F]{6}$'),
  sound text not null default 'chime' check (sound in ('none','chime')),   -- 'chime' = short stinger when the slide appears (video audio is separate: muted until the viewer opts in)
  city text check (city is null or char_length(city) <= 80),               -- null = everywhere; otherwise only members browsing that city
  priority integer not null default 50 check (priority between 0 and 100),
  status text not null default 'draft' check (status in ('draft','live','paused')),
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((media_type is null) = (media_path is null)),
  check (poster_path is null or media_type = 'video'),
  check (ends_at is null or ends_at > starts_at)
);

create index if not exists promo_slides_live_idx on public.promo_slides (status, starts_at, ends_at);

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
