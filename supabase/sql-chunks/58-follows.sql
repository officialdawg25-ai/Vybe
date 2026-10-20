-- ---------------------------------------------------------------- follows
create table if not exists public.follows (
  follower uuid not null references public.profiles(id) on delete cascade,
  target_type text not null check (target_type in ('profile', 'organization')),
  target_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (follower, target_type, target_id),
  check (target_type <> 'profile' or target_id <> follower)
);

create index if not exists follows_target_idx on public.follows (target_type, target_id);

alter table public.follows enable row level security;

drop policy if exists follows_own_read on public.follows;

create policy follows_own_read on public.follows for select to authenticated using (follower = auth.uid());

drop policy if exists follows_own_ins on public.follows;

create policy follows_own_ins on public.follows for insert to authenticated with check (follower = auth.uid());

drop policy if exists follows_own_del on public.follows;

create policy follows_own_del on public.follows for delete to authenticated using (follower = auth.uid());

revoke all on public.follows from anon, authenticated;

grant select, insert, delete on public.follows to authenticated;

-- The target must exist; nobody can follow someone who blocked them (or whom they blocked); capped to stop follow-spam.
create or replace function public.trg_follow_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  if new.target_type = 'profile' then
    if not exists (select 1 from public.profiles where id = new.target_id) then raise exception 'Not found'; end if;
    if public.is_blocked(new.follower, new.target_id) then raise exception 'You cannot follow this account'; end if;
  elsif not exists (select 1 from public.organizations where id = new.target_id) then
    raise exception 'Not found';
  end if;
  select count(*) into n from public.follows where follower = new.follower and created_at > now() - interval '1 hour';
  if n >= 100 then raise exception 'Too many follows in a short time. Try again later.'; end if;
  return new;
end $$;

drop trigger if exists follow_guard on public.follows;

create trigger follow_guard before insert on public.follows for each row execute function public.trg_follow_guard();

-- Aggregate only: how many follow this, and do I.
create or replace function public.follow_stats(p_type text, p_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('followers', (select count(*) from public.follows where target_type = p_type and target_id = p_id),
                            'following', exists (select 1 from public.follows where follower = auth.uid() and target_type = p_type and target_id = p_id));
$$;

-- ---------------------------------------------------------------- notifications
alter table public.notifications drop constraint if exists notifications_type_check;
