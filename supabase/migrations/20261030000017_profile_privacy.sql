-- 17: profile privacy. Until now any signed-in member could read every column of every (unblocked) profile, including
-- city-centre coordinates (lat/lng), notification settings, onboarding answers (intents, step), country and the onboarding
-- and name-change timestamps. Those are now readable only by their owner (through my_profile()) and by security-definer
-- functions that already need them (discovery distance, notifications). Row-level rules are unchanged.
--
-- Public columns (unchanged for everyone): id, username, display_name, bio, avatar_path, location, interests, dm_policy,
-- created_at, cover_path, verified_until, follow_policy, show_followers.
-- Rollback: grant select on public.profiles to authenticated;

revoke select on public.profiles from authenticated, anon;
grant select (id, username, display_name, bio, avatar_path, location, interests, dm_policy, created_at, cover_path, verified_until, follow_policy, show_followers)
  on public.profiles to authenticated;

-- Your own full profile row (all columns), for the app's session and the data export.
create or replace function public.my_profile() returns jsonb
language sql stable security definer set search_path = '' as $$
  select to_jsonb(p) from public.profiles p where p.id = auth.uid();
$$;
revoke execute on function public.my_profile() from public, anon;
grant execute on function public.my_profile() to authenticated;
