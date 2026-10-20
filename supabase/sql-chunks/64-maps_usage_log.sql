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
