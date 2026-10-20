-- 10-expire_orders.sql: run in filename order (voice notes, onboarding data, events near you, tickets). Re-runnable.
create or replace function public.expire_orders() returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  update public.orders set status = 'expired' where status = 'pending' and expires_at < now();
  get diagnostics n = row_count; return n;
end $$;

revoke execute on function public.issue_tickets(uuid, text, text), public.fulfill_order(uuid, text, text, bigint), public.close_order(uuid, text), public.expire_orders() from public, anon, authenticated;

revoke execute on function public.create_order(uuid, jsonb, text, text) from public, anon;

grant execute on function public.create_order(uuid, jsonb, text, text) to authenticated;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.fulfill_order(uuid, text, text, bigint), public.close_order(uuid, text), public.expire_orders() to service_role;
  end if;
end $$;

-- A buyer cancels their own unpaid order (releases the hold immediately).
create or replace function public.cancel_my_order(p_order uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.orders set status = 'cancelled' where id = p_order and buyer = auth.uid() and status = 'pending';
end $$;

revoke execute on function public.cancel_my_order(uuid) from public, anon;

grant execute on function public.cancel_my_order(uuid) to authenticated;

-- One transfer per ticket, only while valid and before the event is over; the new holder must be a friend of the sender.
create or replace function public.transfer_ticket(p_ticket uuid, p_to uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare t public.tickets; ev public.events;
begin
  select * into t from public.tickets where id = p_ticket for update;
  if not found or t.owner <> auth.uid() then raise exception 'Ticket not found'; end if;
  if t.status <> 'valid' then raise exception 'This ticket can no longer be transferred'; end if;
  if t.transfers >= 1 then raise exception 'This ticket has already been transferred once'; end if;
  select * into ev from public.events where id = t.event_id;
  if coalesce(ev.ends_at, ev.starts_at + interval '6 hours') < now() then raise exception 'This event has ended'; end if;
  if p_to = auth.uid() or not public.are_friends(auth.uid(), p_to) then raise exception 'You can only transfer tickets to friends'; end if;
  update public.tickets set owner = p_to, transfers = transfers + 1 where id = p_ticket;
  insert into public.audit_log (actor, action, entity_type, entity_id, detail) values (auth.uid(), 'ticket.transferred', 'ticket', p_ticket, jsonb_build_object('to', p_to));
end $$;

revoke execute on function public.transfer_ticket(uuid, uuid) from public, anon;

grant execute on function public.transfer_ticket(uuid, uuid) to authenticated;
