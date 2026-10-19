drop policy if exists live_delete on public.live_streams;

create policy live_delete on public.live_streams for delete to authenticated using (host = auth.uid() and status in ('scheduled','cancelled'));

revoke all on public.live_streams from anon, authenticated;

grant select on public.live_streams to authenticated;

grant insert (host, organization_id, event_id, title, visibility, scheduled_for, recording_consent) on public.live_streams to authenticated;

grant update (title, visibility, scheduled_for, status, recording_consent) on public.live_streams to authenticated;

grant delete on public.live_streams to authenticated;

-- Streams can be reported like any other entity.
do $$ begin
  alter table public.reports drop constraint if exists reports_entity_type_check;
  alter table public.reports add constraint reports_entity_type_check
    check (entity_type in ('profile','post','comment','message','community','event','stream'));
end $$;

-- ------------------------------------------------- staff moderation (RPC only)
-- Staff never get blanket table access. They see only the reported item, via an audited RPC.
create or replace function public.staff_report_context(rid uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.reports; ctx jsonb;
begin
  if not public.is_staff() then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into r from public.reports where id = rid;
  if not found then raise exception 'report not found'; end if;
  ctx := case r.entity_type
    when 'post' then (select jsonb_build_object('text', body, 'author', author, 'media', media_path is not null) from public.posts where id = r.entity_id)
    when 'comment' then (select jsonb_build_object('text', body, 'author', author) from public.comments where id = r.entity_id)
    when 'message' then (select jsonb_build_object('text', body, 'author', sender) from public.messages where id = r.entity_id)
    when 'event' then (select jsonb_build_object('text', title || E'\n' || description, 'author', host) from public.events where id = r.entity_id)
    when 'community' then (select jsonb_build_object('text', name || E'\n' || description, 'author', created_by) from public.communities where id = r.entity_id)
    when 'profile' then (select jsonb_build_object('text', username || E'\n' || display_name || E'\n' || bio, 'author', id) from public.profiles where id = r.entity_id)
    when 'stream' then (select jsonb_build_object('text', title, 'author', host) from public.live_streams where id = r.entity_id)
  end;
  insert into public.audit_log (actor, action, entity_type, entity_id, detail)
  values (auth.uid(), 'report.context_viewed', r.entity_type, r.entity_id, jsonb_build_object('report', rid));
  return coalesce(ctx, jsonb_build_object('text', null, 'gone', true));
end $$;
