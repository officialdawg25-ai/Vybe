-- 02-update.sql: run in filename order (voice notes, onboarding data, events near you, tickets). Re-runnable.
grant update (country, lat, lng, intents, onboarding_step) on public.profiles to authenticated;

create table if not exists public.profile_private (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  birth_date date,
  terms_accepted_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.profile_private enable row level security;

drop policy if exists pp_select on public.profile_private;

create policy pp_select on public.profile_private for select to authenticated using (user_id = auth.uid());

drop policy if exists pp_insert on public.profile_private;

create policy pp_insert on public.profile_private for insert to authenticated with check (user_id = auth.uid());

drop policy if exists pp_update on public.profile_private;

create policy pp_update on public.profile_private for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

revoke all on public.profile_private from anon, authenticated;

grant select on public.profile_private to authenticated;

grant insert (user_id, birth_date, terms_accepted_at) on public.profile_private to authenticated;

grant update (birth_date, terms_accepted_at) on public.profile_private to authenticated;

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
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists profile_age on public.profile_private;

create trigger profile_age before insert or update on public.profile_private for each row execute function public.trg_profile_age();

-- ------------------------------------------------------------ events: where
alter table public.events add column if not exists city text check (city is null or char_length(city) <= 80);

alter table public.events add column if not exists country text check (country is null or char_length(country) <= 80);

alter table public.events add column if not exists venue text check (venue is null or char_length(venue) <= 120);

alter table public.events add column if not exists address text check (address is null or char_length(address) <= 240);

alter table public.events add column if not exists lat double precision check (lat is null or lat between -90 and 90);

alter table public.events add column if not exists lng double precision check (lng is null or lng between -180 and 180);
