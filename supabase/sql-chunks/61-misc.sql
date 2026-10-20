do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then grant execute on function public.live_apply_event(text, text, integer) to service_role; end if;
end $$;

-- ---------------------------------------------------------------- social context for one event
create or replace function public.event_social(p_event uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare r jsonb;
begin
  if auth.uid() is null or not public.can_view_event_id(p_event) then return null; end if;
  select jsonb_build_object(
    'going', (select count(*) from public.event_rsvps where event_id = p_event and status = 'going'),
    'interested', (select count(*) from public.event_rsvps where event_id = p_event and status = 'maybe'),
    'saved', exists (select 1 from public.event_saves where event_id = p_event and user_id = auth.uid()),
    'mine', (select jsonb_build_object('status', status, 'visibility', visibility) from public.event_rsvps where event_id = p_event and user_id = auth.uid()),
    'people', coalesce((
      select jsonb_agg(jsonb_build_object('id', x.id, 'username', x.username, 'display_name', x.display_name, 'avatar_path', x.avatar_path, 'status', x.status, 'friend', x.friend) order by x.friend desc, x.updated_at desc)
      from (select p.id, p.username, p.display_name, p.avatar_path, r.status, r.updated_at, public.are_friends(auth.uid(), p.id) as friend
            from public.event_rsvps r join public.profiles p on p.id = r.user_id
            where r.event_id = p_event and r.status in ('going', 'maybe') and r.user_id <> auth.uid()
              and not public.is_blocked(auth.uid(), r.user_id)
              and (r.visibility = 'public' or (r.visibility = 'friends' and public.are_friends(auth.uid(), r.user_id)))
            order by public.are_friends(auth.uid(), p.id) desc, r.updated_at desc limit 24) x), '[]'::jsonb)
  ) into r;
  return r;
end $$;
