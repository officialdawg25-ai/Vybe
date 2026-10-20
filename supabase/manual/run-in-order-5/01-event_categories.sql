-- Discover upgrade: configurable categories, event format/draft state, follows (people + organizations), per-RSVP privacy,
-- saved events, follower/attendee-aware discovery RPCs, event-related live listing, preference-aware notifications and a maps rate limit.
-- Additive and re-runnable. Existing events, RSVPs and notifications are preserved.
--   * Artists / venues / organisers are `organizations` (kind now includes 'artist'); people can be followed too.
--   * Communities are "followed" by joining (community_members) — no second relationship table.
--   * "Interested" is the existing RSVP status 'maybe'; "Going" is 'going'. Saved is separate (event_saves).

-- ---------------------------------------------------------------- categories (admin-configurable source of truth)
create table if not exists public.event_categories (
  slug text primary key check (slug ~ '^[a-z0-9-]{2,30}$'),
  label text not null check (char_length(label) between 2 and 40),
  group_key text not null default 'events' check (group_key in ('concerts', 'events')),   -- 'concerts' = shown under Concerts & shows
  sort integer not null default 100,
  active boolean not null default true
);

alter table public.event_categories enable row level security;

drop policy if exists event_categories_read on public.event_categories;

create policy event_categories_read on public.event_categories for select to authenticated using (true);

drop policy if exists event_categories_admin on public.event_categories;

create policy event_categories_admin on public.event_categories for all to authenticated using (public.is_admin()) with check (public.is_admin());

revoke all on public.event_categories from anon, authenticated;

grant select, insert, update, delete on public.event_categories to authenticated;

insert into public.event_categories (slug, label, group_key, sort) values
  ('concerts', 'Concerts & gigs', 'concerts', 10), ('festivals', 'Festivals', 'concerts', 20), ('comedy', 'Comedy', 'concerts', 30),
  ('theatre', 'Theatre & performance', 'concerts', 40), ('open-mic', 'Open mic & showcases', 'concerts', 50),
  ('nightlife', 'Nightlife & social', 'events', 60), ('arts-culture', 'Arts & culture', 'events', 70), ('sports', 'Sports & recreation', 'events', 80),
  ('workshops', 'Workshops & learning', 'events', 90), ('networking', 'Business & networking', 'events', 100), ('food', 'Food & lifestyle', 'events', 110),
  ('family', 'Family friendly', 'events', 120), ('student', 'University & student', 'events', 130), ('community', 'Local community', 'events', 140),
  ('other', 'Other', 'events', 999)
on conflict (slug) do nothing;

-- ---------------------------------------------------------------- events: category, format, drafts, provenance
alter table public.events add column if not exists category text references public.event_categories(slug) on update cascade on delete set null;

alter table public.events add column if not exists format text not null default 'in_person' check (format in ('in_person', 'online', 'hybrid'));

alter table public.events add column if not exists online_url text check (online_url is null or (char_length(online_url) <= 500 and online_url ~* '^https://'));

alter table public.events add column if not exists source text not null default 'vybe' check (source in ('vybe', 'external'));

alter table public.events add column if not exists source_name text check (source_name is null or char_length(source_name) <= 60);

alter table public.events add column if not exists source_url text check (source_url is null or (char_length(source_url) <= 500 and source_url ~* '^https://'));

alter table public.events drop constraint if exists events_status_check;

alter table public.events add constraint events_status_check check (status in ('draft', 'active', 'cancelled', 'completed'));

alter table public.events drop constraint if exists events_online_needs_link;

alter table public.events add constraint events_online_needs_link check (format = 'in_person' or online_url is not null or status = 'draft');
