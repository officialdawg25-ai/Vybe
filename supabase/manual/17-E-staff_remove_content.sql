create or replace function public.staff_remove_content(rid uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.reports;
begin
  if not public.is_staff() then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into r from public.reports where id = rid;
  if not found then raise exception 'report not found'; end if;
  case r.entity_type
    when 'post' then delete from public.posts where id = r.entity_id;
    when 'comment' then delete from public.comments where id = r.entity_id;
    when 'event' then update public.events set status = 'cancelled' where id = r.entity_id;
    when 'community' then delete from public.communities where id = r.entity_id;
    when 'stream' then update public.live_streams set status = 'cancelled' where id = r.entity_id and status = 'scheduled';
    when 'message' then update public.messages set body = 'Message removed', deleted_at = now() where id = r.entity_id;
    else raise exception 'this content type cannot be removed from here';
  end case;
  update public.reports set status = 'actioned' where id = rid;
  insert into public.audit_log (actor, action, entity_type, entity_id, detail)
  values (auth.uid(), 'content.removed', r.entity_type, r.entity_id, jsonb_build_object('report', rid));
end $$;

revoke execute on function public.staff_report_context(uuid), public.staff_remove_content(uuid) from public, anon;

grant execute on function public.staff_report_context(uuid), public.staff_remove_content(uuid) to authenticated;
