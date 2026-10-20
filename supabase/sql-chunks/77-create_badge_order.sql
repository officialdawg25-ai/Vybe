-- Priced from verification_plans on the server; the browser sends only a plan id. Idempotent per (buyer, key).
create or replace function public.create_badge_order(p_plan text, p_provider text, p_idem text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid(); pl public.verification_plans; pr public.profiles; o public.badge_orders; recent integer;
begin
  if me is null then raise exception 'Sign in' using errcode = '28000'; end if;
  if p_provider not in ('payfast', 'ozow') then raise exception 'Choose PayFast or Ozow'; end if;
  select * into o from public.badge_orders where buyer = me and idempotency_key = p_idem;
  if found then return jsonb_build_object('id', o.id, 'status', o.status, 'total_cents', o.total_cents, 'expires_at', o.expires_at); end if;
  select * into pl from public.verification_plans where id = p_plan and active;
  if not found then raise exception 'That plan is not available'; end if;
  select * into pr from public.profiles where id = me;
  if coalesce(btrim(pr.display_name), '') = '' or pr.avatar_path is null then raise exception 'Add a profile photo and your name before applying for the badge'; end if;
  select count(*) into recent from public.badge_orders where buyer = me and created_at > now() - interval '1 hour';
  if recent >= 5 then raise exception 'Too many attempts. Please wait a while.'; end if;
  insert into public.badge_orders (buyer, plan_id, days, total_cents, provider, idempotency_key, expires_at)
  values (me, pl.id, pl.days, pl.price_cents, p_provider, p_idem, now() + interval '30 minutes') returning * into o;
  return jsonb_build_object('id', o.id, 'status', o.status, 'total_cents', o.total_cents, 'expires_at', o.expires_at);
end $$;

-- Service role only (payment webhooks). Idempotent; amount and provider must match what we priced.
create or replace function public.fulfill_badge_order(p_order uuid, p_provider text, p_ref text, p_amount_cents bigint) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.badge_orders;
begin
  select * into o from public.badge_orders where id = p_order for update;
  if not found then raise exception 'Order not found'; end if;
  if o.status = 'paid' then return; end if;
  if o.provider <> p_provider then raise exception 'Provider mismatch'; end if;
  if o.total_cents <> p_amount_cents then raise exception 'Amount mismatch'; end if;
  update public.badge_orders set status = 'paid', provider_ref = p_ref, paid_at = now() where id = o.id;
  update public.profiles set verified_until = greatest(now(), coalesce(verified_until, now())) + make_interval(days => o.days) where id = o.buyer;
  insert into public.audit_log (actor, action, entity_type, entity_id, detail) values (null, 'verified.paid', 'profile', o.buyer, jsonb_build_object('order', o.id, 'days', o.days, 'cents', o.total_cents));
  perform public.notify(o.buyer, 'verified', null, 'profile', o.buyer, 'vf:' || o.id);
end $$;

create or replace function public.close_badge_order(p_order uuid, p_status text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_status not in ('failed', 'cancelled', 'expired') then raise exception 'bad status'; end if;
  update public.badge_orders set status = p_status where id = p_order and status = 'pending';
end $$;

create or replace function public.admin_set_verified(p_user uuid, p_until timestamptz) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.profiles set verified_until = p_until where id = p_user;
  insert into public.audit_log (actor, action, entity_type, entity_id, detail) values (auth.uid(), 'verified.admin_set', 'profile', p_user, jsonb_build_object('until', p_until));
end $$;

revoke execute on function public.music_catalog(text, text, integer), public.memory_rail(integer), public.author_memories(uuid, boolean), public.get_profile_details(uuid, text),
  public.profile_stats(uuid), public.create_badge_order(text, text, text), public.admin_set_verified(uuid, timestamptz), public.can_view_memory_id(uuid), public.can_reply_memory(uuid),
  public.fulfill_badge_order(uuid, text, text, bigint), public.close_badge_order(uuid, text) from public, anon;

grant execute on function public.music_catalog(text, text, integer), public.memory_rail(integer), public.author_memories(uuid, boolean), public.get_profile_details(uuid, text),
  public.profile_stats(uuid), public.create_badge_order(text, text, text), public.admin_set_verified(uuid, timestamptz), public.can_view_memory_id(uuid), public.can_reply_memory(uuid) to authenticated;

revoke execute on function public.fulfill_badge_order(uuid, text, text, bigint), public.close_badge_order(uuid, text) from authenticated;
