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

-- External listings can only be written by trusted server code (service role); browsers cannot claim a provider identity.
alter table public.events drop constraint if exists events_external_has_source;

alter table public.events add constraint events_external_has_source check (source = 'vybe' or (source_name is not null and source_url is not null));

create index if not exists events_discover_idx on public.events (status, visibility, starts_at);

create index if not exists events_category_idx on public.events (category) where category is not null;

grant insert (category, format, online_url, status) on public.events to authenticated;

grant update (category, format, online_url, status) on public.events to authenticated;

-- Table-level grants cover these columns, so a trigger (not a column revoke) keeps provider identity server-side only.
create or replace function public.trg_event_source_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if auth.uid() is not null and (new.source <> 'vybe' or new.source_name is not null or new.source_url is not null)
     and (tg_op = 'INSERT' or (new.source, new.source_name, new.source_url) is distinct from (old.source, old.source_name, old.source_url)) then
    raise exception 'External listings can only be created by VYBE servers' using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists event_source_guard on public.events;
