create or replace function public.issue_tickets(p_order uuid, p_provider text, p_ref text, p_method text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.orders; r record; n integer; k integer; cfg public.platform_config; pay record; lines jsonb; bname text;
begin
  select * into o from public.orders where id = p_order for update;
  if not found then raise exception 'order not found'; end if;
  if o.status in ('paid','partially_refunded','refunded','disputed') then return; end if;
  if o.status not in ('pending','expired') then raise exception 'order is %', o.status; end if;
  if o.status = 'expired' then
    for r in select oi.ticket_type_id, oi.qty, tt.quantity_total from public.order_items oi join public.ticket_types tt on tt.id = oi.ticket_type_id where oi.order_id = o.id loop
      if public.ticket_units_taken(r.ticket_type_id) + r.qty > r.quantity_total then
        update public.orders set status = 'failed', provider = p_provider, provider_ref = p_ref where id = o.id;
        insert into public.audit_log (actor, action, entity_type, entity_id, detail) values (null, 'order.paid_after_expiry_soldout', 'order', o.id, jsonb_build_object('provider', p_provider, 'ref', p_ref));
        return;
      end if;
    end loop;
  end if;
  for r in select oi.qty, oi.ticket_type_id, tt.group_size from public.order_items oi join public.ticket_types tt on tt.id = oi.ticket_type_id where oi.order_id = o.id loop
    n := r.qty * r.group_size;
    for k in 1..n loop
      insert into public.tickets (order_id, event_id, ticket_type_id, owner, code)
      values (o.id, o.event_id, r.ticket_type_id, o.buyer, upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 20)));
    end loop;
  end loop;
  update public.orders set status = 'paid', provider = p_provider, provider_ref = coalesce(p_ref, provider_ref), payment_method = coalesce(p_method, payment_method), paid_at = now() where id = o.id;

  -- organizer's share of the sale goes on the ledger
  select * into pay from public.event_payee(o.event_id);
  if o.subtotal_cents > 0 then
    insert into public.ledger_entries (event_id, organization_id, payee_user, order_id, kind, amount_cents, note)
    values (o.event_id, pay.org, pay.usr, o.id, 'sale', o.subtotal_cents, 'Ticket sales');
  end if;

  -- receipt / tax invoice for the buyer
  select * into cfg from public.platform_config where id;
  select coalesce(nullif(display_name, ''), username) into bname from public.profiles where id = o.buyer;
  select coalesce(jsonb_agg(jsonb_build_object('name', tt.name, 'qty', oi.qty, 'unit_price_cents', oi.unit_price_cents, 'line_total_cents', oi.qty * oi.unit_price_cents, 'tickets', oi.qty * tt.group_size)), '[]'::jsonb)
    into lines from public.order_items oi join public.ticket_types tt on tt.id = oi.ticket_type_id where oi.order_id = o.id;
  insert into public.invoices (order_id, buyer, number, kind, legal_name, vat_number, buyer_name, lines, subtotal_cents, fee_cents, fee_vat_cents, total_cents)
  values (o.id, o.buyer, 'VYB-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('public.invoice_seq')::text, 6, '0'),
          case when cfg.vat_registered and cfg.vat_number is not null then 'tax_invoice' else 'receipt' end,
          cfg.legal_name, case when cfg.vat_registered then cfg.vat_number end, coalesce(bname, ''), lines, o.subtotal_cents, o.fee_cents, o.fee_vat_cents, o.total_cents)
  on conflict (order_id) do nothing;

  begin
    insert into public.event_rsvps (event_id, user_id, status) values (o.event_id, o.buyer, 'going')
    on conflict (event_id, user_id) do update set status = 'going';
  exception when others then null;
  end;
end $$;
