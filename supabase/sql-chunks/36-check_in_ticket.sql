-- Door check-in: atomic and single use. Only the event's host or organization editors may scan.
create or replace function public.check_in_ticket(p_code text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare t public.tickets; tt public.ticket_types; holder public.profiles; c text := upper(trim(p_code));
begin
  select * into t from public.tickets where code = c;
  if not found then return jsonb_build_object('result', 'invalid'); end if;
  if not public.can_manage_event(t.event_id) then return jsonb_build_object('result', 'forbidden'); end if;
  select * into tt from public.ticket_types where id = t.ticket_type_id;
  select * into holder from public.profiles where id = t.owner;
  update public.tickets set status = 'used', used_at = now(), used_by = auth.uid() where id = t.id and status = 'valid';
  if found then
    return jsonb_build_object('result', 'ok', 'ticket_type', tt.name, 'holder', coalesce(nullif(holder.display_name, ''), holder.username));
  end if;
  select * into t from public.tickets where id = t.id;
  return jsonb_build_object('result', case when t.status = 'void' then 'void' else 'used' end, 'ticket_type', tt.name,
                            'holder', coalesce(nullif(holder.display_name, ''), holder.username), 'used_at', t.used_at);
end $$;

revoke execute on function public.check_in_ticket(text) from public, anon;

grant execute on function public.check_in_ticket(text) to authenticated;
