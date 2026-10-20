alter table public.profiles add column if not exists lng double precision check (lng is null or lng between -180 and 180);

alter table public.profiles add column if not exists intents text[] not null default '{}' check (cardinality(intents) <= 8);

alter table public.profiles add column if not exists onboarding_step integer not null default 0 check (onboarding_step between 0 and 20);

alter table public.profiles add column if not exists terms_accepted_at timestamptz;

grant update (birth_date, country, lat, lng, intents, onboarding_step, terms_accepted_at) on public.profiles to authenticated;

-- Minimum age 13, enforced server-side.
create or replace function public.trg_profile_age() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.birth_date is not null and new.birth_date > (current_date - interval '13 years')::date then
    raise exception 'You must be at least 13 to use VYBE' using errcode = '22023';
  end if;
  if new.birth_date is not null and new.birth_date < date '1900-01-01' then
    raise exception 'Invalid birth date' using errcode = '22023';
  end if;
  return new;
end $$;

drop trigger if exists profile_age on public.profiles;

create trigger profile_age before insert or update of birth_date on public.profiles for each row execute function public.trg_profile_age();

-- ------------------------------------------------------------ events: where
alter table public.events add column if not exists city text check (city is null or char_length(city) <= 80);

alter table public.events add column if not exists country text check (country is null or char_length(country) <= 80);

alter table public.events add column if not exists venue text check (venue is null or char_length(venue) <= 120);

alter table public.events add column if not exists address text check (address is null or char_length(address) <= 240);

alter table public.events add column if not exists lat double precision check (lat is null or lat between -90 and 90);

alter table public.events add column if not exists lng double precision check (lng is null or lng between -180 and 180);

create index if not exists events_geo_idx on public.events (lat, lng) where lat is not null;

grant update (city, country, venue, address, lat, lng) on public.events to authenticated;

grant insert (city, country, venue, address, lat, lng) on public.events to authenticated;
