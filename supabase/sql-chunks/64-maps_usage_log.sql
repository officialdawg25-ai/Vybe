alter table public.maps_usage_log enable row level security;

revoke all on public.maps_usage_log from anon, authenticated;

create or replace function public.maps_gate(p_op text) returns void
language plpgsql security definer set search_path = '' as $$
declare recent integer;
begin
  if auth.uid() is null then raise exception 'Sign in' using errcode = '28000'; end if;
  select count(*) into recent from public.maps_usage_log where user_id = auth.uid() and created_at > now() - interval '1 minute';
  if recent >= 40 then raise exception 'Too many map requests. Please wait a moment.'; end if;
  insert into public.maps_usage_log (user_id, op) values (auth.uid(), left(p_op, 20));
  delete from public.maps_usage_log where created_at < now() - interval '2 days' and id % 50 = 0;
end $$;

revoke execute on function public.follow_stats(text, uuid), public.event_social(uuid), public.discover_events(text, text, text[], text, boolean, timestamptz, timestamptz, double precision, double precision, double precision, boolean, boolean, boolean, text, integer, integer),
  public.discover_orgs(text[], text, boolean, integer, integer), public.discover_live(integer), public.maps_gate(text) from public, anon;

grant execute on function public.follow_stats(text, uuid), public.event_social(uuid), public.discover_events(text, text, text[], text, boolean, timestamptz, timestamptz, double precision, double precision, double precision, boolean, boolean, boolean, text, integer, integer),
  public.discover_orgs(text[], text, boolean, integer, integer), public.discover_live(integer), public.maps_gate(text) to authenticated;

-- Create-post upgrade, memories (stories), music, profile depth and paid verification. Additive and re-runnable.
--   * Posts get multiple media, a feeling/activity, a place, tagged friends and an attached song.
--   * Memories are 24-hour public/friends moments with views, reactions and text/voice replies (replies go to the owner only).
--   * Profiles get a cover photo, detailed sections with per-section visibility, follow/privacy settings and a paid "VYBE Verified" badge.
--   * Everything is guarded by RLS or security-definer functions that re-check who is asking.

-- ---------------------------------------------------------------- notification types
alter table public.notifications drop constraint if exists notifications_type_check;

alter table public.notifications add constraint notifications_type_check check (type in
  ('friend_request', 'friend_accepted', 'reaction', 'comment', 'event_invite', 'rsvp', 'community_join', 'new_event', 'event_update', 'event_cancelled', 'live_started',
   'post_tag', 'memory_reaction', 'memory_reply', 'verified'));

-- ---------------------------------------------------------------- profiles: cover, verification, follow/privacy settings
alter table public.profiles add column if not exists cover_path text;

alter table public.profiles add column if not exists verified_until timestamptz;

-- written only by server-side functions (payment) or an admin
alter table public.profiles add column if not exists follow_policy text not null default 'everyone' check (follow_policy in ('everyone', 'friends'));

alter table public.profiles add column if not exists show_followers text not null default 'public' check (show_followers in ('public', 'friends', 'me'));

grant update (cover_path, follow_policy, show_followers) on public.profiles to authenticated;
