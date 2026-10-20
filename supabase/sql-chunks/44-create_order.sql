-- ------------------------------------------------------------------ orders: VAT on the service fee, risk gate, receipts, ledger
create or replace function public.create_order(p_event uuid, p_items jsonb, p_provider text, p_idem text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid(); ev public.events; cfg public.platform_config; ord public.orders;
  it jsonb; tt public.ticket_types; q integer; subtotal bigint := 0; fee bigint := 0; vat bigint := 0; total_units integer := 0; mine integer;
begin
  if uid is null then raise exception 'Sign in to buy tickets' using errcode = '28000'; end if;
  if exists (select 1 from public.buyer_flags where user_id = uid) then raise exception 'Purchases are disabled for this account. Please contact support.'; end if;
  if p_provider is null or p_provider not in ('payfast','ozow') then raise exception 'Choose PayFast or Ozow'; end if;
  if p_idem is null or char_length(p_idem) < 8 then raise exception 'Missing idempotency key'; end if;
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) not between 1 and 10 then raise exception 'Choose at least one ticket'; end if;

  select * into ord from public.orders where buyer = uid and idempotency_key = p_idem;
  if found then return jsonb_build_object('id', ord.id, 'status', ord.status, 'total_cents', ord.total_cents, 'fee_cents', ord.fee_cents, 'subtotal_cents', ord.subtotal_cents, 'expires_at', ord.expires_at); end if;

  select * into cfg from public.platform_config where id;
  select * into ev from public.events e where e.id = p_event;
  if not found or ev.status <> 'active' or not public.can_view_event(ev) then raise exception 'This event is not available'; end if;
  if coalesce(ev.ends_at, ev.starts_at + interval '6 hours') < now() then raise exception 'This event has ended'; end if;

  if (select count(*) from public.orders where buyer = uid and created_at > now() - interval '10 minutes') >= 6 then raise exception 'Too many attempts. Please wait a few minutes.'; end if;
  if (select count(*) from public.orders where buyer = uid and created_at > now() - interval '24 hours') >= 30 then raise exception 'Daily purchase limit reached.'; end if;
  if (select count(*) from public.orders where buyer = uid and status = 'pending' and expires_at > now()) >= 3 then raise exception 'Finish or cancel your pending orders first.'; end if;

  for it in select * from jsonb_array_elements(p_items) loop
    q := (it->>'qty')::integer;
    select * into tt from public.ticket_types where id = (it->>'ticket_type_id')::uuid and event_id = p_event for update;
    if not found then raise exception 'Unknown ticket type'; end if;
    if tt.status <> 'active' then raise exception '% is not on sale', tt.name; end if;
    if tt.sales_start is not null and tt.sales_start > now() then raise exception '% is not on sale yet', tt.name; end if;
    if tt.sales_end is not null and tt.sales_end < now() then raise exception 'Sales for % have closed', tt.name; end if;
    if q is null or q < 1 or q > tt.max_per_order then raise exception 'You can buy 1 to % of %', tt.max_per_order, tt.name; end if;
    if public.ticket_units_taken(tt.id) + q > tt.quantity_total then raise exception '% is sold out', tt.name; end if;
    subtotal := subtotal + tt.price_cents::bigint * q;
    total_units := total_units + q * tt.group_size;
  end loop;
  if total_units > cfg.max_tickets_per_order then raise exception 'You can buy up to % tickets per order', cfg.max_tickets_per_order; end if;
  select count(*) into mine from public.tickets where owner = uid and event_id = p_event and status in ('valid','used');
  if mine + total_units > 20 then raise exception 'Ticket limit per person reached for this event'; end if;

  if subtotal > 0 then
    fee := ceil(subtotal * cfg.fee_bps / 10000.0)::bigint + cfg.fee_fixed_cents;                  -- VAT-inclusive when VAT-registered
    if cfg.vat_registered then vat := round(fee * cfg.vat_rate_bps / (10000.0 + cfg.vat_rate_bps))::bigint; end if;
  end if;
  if subtotal + fee > 0 and subtotal + fee < 500 then raise exception 'The minimum card/EFT payment is R5.00'; end if;

  insert into public.orders (buyer, event_id, provider, subtotal_cents, fee_cents, fee_vat_cents, total_cents, idempotency_key, expires_at)
  values (uid, p_event, case when subtotal = 0 then 'free' else p_provider end, subtotal, fee, vat, subtotal + fee, p_idem, now() + make_interval(mins => cfg.hold_minutes))
  returning * into ord;
  for it in select * from jsonb_array_elements(p_items) loop
    insert into public.order_items (order_id, ticket_type_id, qty, unit_price_cents)
    select ord.id, t.id, (it->>'qty')::integer, t.price_cents from public.ticket_types t where t.id = (it->>'ticket_type_id')::uuid;
  end loop;

  if ord.total_cents = 0 then perform public.issue_tickets(ord.id, 'free', null); select * into ord from public.orders where id = ord.id; end if;
  return jsonb_build_object('id', ord.id, 'status', ord.status, 'total_cents', ord.total_cents, 'fee_cents', ord.fee_cents, 'subtotal_cents', ord.subtotal_cents, 'expires_at', ord.expires_at);
end $$;
