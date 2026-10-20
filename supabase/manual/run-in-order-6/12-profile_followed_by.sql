-- "Followed by A, B and 6 others": people who follow this account and are also your friends or accounts you follow. Names and counts only.
create or replace function public.profile_followed_by(p_user uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare me uuid := auth.uid(); r jsonb;
begin
  if me is null then raise exception 'Sign in' using errcode = '28000'; end if;
  if me = p_user or public.is_blocked(me, p_user) then return jsonb_build_object('count', 0, 'people', '[]'::jsonb); end if;
  with common as (
    select f.follower as id from public.follows f
    where f.target_type = 'profile' and f.target_id = p_user and f.follower <> me
      and (public.are_friends(me, f.follower) or exists (select 1 from public.follows mine where mine.follower = me and mine.target_type = 'profile' and mine.target_id = f.follower))
      and not public.is_blocked(me, f.follower)
  )
  select jsonb_build_object('count', (select count(*) from common),
    'people', coalesce((select jsonb_agg(jsonb_build_object('username', p.username, 'display_name', p.display_name, 'avatar_path', p.avatar_path))
                        from (select pr.username, pr.display_name, pr.avatar_path from common c join public.profiles pr on pr.id = c.id order by pr.username limit 3) p), '[]'::jsonb)) into r;
  return r;
end $$;

-- Discover people: accounts you do not follow yet, "Follow back" first, then most friends in common, then most shared interests.
create or replace function public.people_suggestions(p_limit integer default 40) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare me uuid := auth.uid(); r jsonb; mine text[];
begin
  if me is null then raise exception 'Sign in' using errcode = '28000'; end if;
  select interests into mine from public.profiles where id = me;
  select coalesce(jsonb_agg(x.j order by x.fb desc, x.mutual desc, x.shared desc, x.created_at desc), '[]'::jsonb) into r from (
    select jsonb_build_object('id', p.id, 'username', p.username, 'display_name', p.display_name, 'avatar_path', p.avatar_path, 'verified_until', p.verified_until,
             'follows_me', fm.v, 'friend', public.are_friends(me, p.id), 'mutual', mu.n, 'shared', to_jsonb(sh.arr)) as j,
           fm.v as fb, mu.n as mutual, coalesce(cardinality(sh.arr), 0) as shared, p.created_at
    from public.profiles p
    cross join lateral (select exists (select 1 from public.follows f where f.follower = p.id and f.target_type = 'profile' and f.target_id = me) as v) fm
    cross join lateral (select count(*) as n from public.friendships a join public.friendships b
        on ((a.requester = me and a.addressee = case when b.requester = p.id then b.addressee else b.requester end) or (a.addressee = me and a.requester = case when b.requester = p.id then b.addressee else b.requester end))
       where a.status = 'accepted' and b.status = 'accepted' and (b.requester = p.id or b.addressee = p.id)) mu
    cross join lateral (select array(select i from unnest(p.interests) i where i = any (coalesce(mine, '{}'))) as arr) sh
    where p.id <> me and not public.is_blocked(me, p.id)
      and not exists (select 1 from public.follows f where f.follower = me and f.target_type = 'profile' and f.target_id = p.id)
      and (p.follow_policy = 'everyone' or public.are_friends(me, p.id))
    order by fm.v desc, mu.n desc, coalesce(cardinality(sh.arr), 0) desc, p.created_at desc
    limit least(greatest(p_limit, 1), 100)
  ) x;
  return r;
end $$;

-- ---------------------------------------------------------------- VYBE Verified (paid badge)
create table if not exists public.verification_plans (
  id text primary key check (id ~ '^[a-z0-9_-]{3,20}$'),
  label text not null check (char_length(label) between 3 and 60),
  days integer not null check (days between 1 and 3660),
  price_cents integer not null check (price_cents >= 100),
  active boolean not null default true,
  sort integer not null default 100
);

alter table public.verification_plans enable row level security;

drop policy if exists verification_plans_read on public.verification_plans;

create policy verification_plans_read on public.verification_plans for select to authenticated using (active or public.is_admin());
