-- 42: Followers and following lists on a profile.
--
-- profile_connections(user, 'followers' | 'following') returns the people behind the counts on a profile (id, name, picture,
-- verified, and whether the viewer follows them), 40 at a time, most recent first. It follows the same privacy rule as the counts
-- themselves (profile_stats): the owner always sees their own; others only when the owner's "who can see followers" choice
-- allows it (everyone / friends / only me); nothing at all across a block; blocked people are left out of the list.
-- Additive. Rollback: drop function public.profile_connections(uuid, text, integer, integer).

create or replace function public.profile_connections(p_user uuid, p_kind text, p_limit integer default 40, p_offset integer default 0) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare me uuid := auth.uid(); pol text; allowed boolean;
begin
  if me is null then raise exception 'Sign in' using errcode = '28000'; end if;
  if p_kind not in ('followers', 'following') then raise exception 'kind must be followers or following' using errcode = '22023'; end if;
  if me <> p_user and public.is_blocked(me, p_user) then return '[]'::jsonb; end if;
  select show_followers into pol from public.profiles where id = p_user;
  allowed := me = p_user or pol = 'public' or (pol = 'friends' and public.are_friends(me, p_user));
  if not allowed then return null; end if;                                  -- hidden by its owner: null, not an empty list
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', x.id, 'username', x.username, 'display_name', x.display_name, 'avatar_path', x.avatar_path,
                                        'verified_until', x.verified_until, 'i_follow', x.i_follow) order by x.at desc)
    from (
      select pr.id, pr.username, pr.display_name, pr.avatar_path, pr.verified_until, f.created_at as at,
             exists (select 1 from public.follows m where m.follower = me and m.target_type = 'profile' and m.target_id = pr.id) as i_follow
      from public.follows f
      join public.profiles pr on pr.id = case when p_kind = 'followers' then f.follower else f.target_id end
      where f.target_type = 'profile'
        and ((p_kind = 'followers' and f.target_id = p_user) or (p_kind = 'following' and f.follower = p_user))
        and (pr.id = me or not public.is_blocked(me, pr.id))
      order by f.created_at desc
      limit least(greatest(coalesce(p_limit, 40), 1), 100) offset greatest(coalesce(p_offset, 0), 0)
    ) x), '[]'::jsonb);
end $$;
revoke execute on function public.profile_connections(uuid, text, integer, integer) from public, anon;
grant execute on function public.profile_connections(uuid, text, integer, integer) to authenticated;
