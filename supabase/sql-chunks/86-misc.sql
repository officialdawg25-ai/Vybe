do $$
declare f text;
begin
  foreach f in array array[
    'public.are_friends(uuid, uuid)', 'public.is_blocked(uuid, uuid)', 'public.can_moderate_community(uuid)',
    'public.can_view_event(public.events)', 'public.can_view_memory(public.memories)', 'public.can_view_post(public.posts)',
    'public.community_is_public(uuid)', 'public.community_role(uuid)', 'public.has_feature(text, uuid)',
    'public.is_community_member(uuid)', 'public.is_conversation_member(uuid)', 'public.is_invited(uuid)', 'public.org_role(uuid)'
  ] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
end $$;
