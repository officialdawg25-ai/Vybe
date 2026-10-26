-- VYBE Tickets, migration 29: launch terms with an organiser commission, provider processing fees in the journal,
-- transactional email for ticket and money notifications (outbox drained by the email-send Edge Function), and a
-- recorded failure path for payouts that were approved but could not be paid.
--
-- Rollback notes: the platform v2 terms can be replaced by a newer version (Admin → Tickets & Trust → Terms) at any time;
-- orders keep the terms they were priced under. Emails stop if the cron job 'vybe-email' is unscheduled.

-- ---------------------------------------------------------------- 1. platform terms v2: organiser commission, no buyer fee
-- Decided by the owner (2026-10-26): VYBE charges organisers a commission; buyers pay the ticket price only. 5 % of the
-- ticket subtotal is the brief's standard rate. Existing orders keep their own snapshot; only new orders use v2.
do $$
declare v2 uuid; starts timestamptz := now();
begin
  if not exists (select 1 from public.fee_policies where scope = 'platform' and name = 'Platform v2 (organiser commission)') then
    insert into public.fee_policies (scope, name, commission_bps, buyer_fee_enabled, effective_from, note)
    values ('platform', 'Platform v2 (organiser commission)', 500, false, starts,
            'Owner decision: organisers pay a 5 % commission on the ticket subtotal; buyers pay the ticket price only.')
    returning id into v2;
    update public.fee_policies set retired_at = starts where scope = 'platform' and id <> v2 and retired_at is null and effective_from <= starts;
    insert into public.audit_log (actor, action, entity_type, entity_id, detail)
    values (null, 'fee_policy.created', 'fee_policy', v2, jsonb_build_object('scope', 'platform', 'commission_bps', 500, 'buyer_fee_enabled', false, 'source', 'migration 29'));
  end if;
end $$;

-- ---------------------------------------------------------------- 2. provider processing fees
-- PayFast reports its fee on every payment notification (amount_fee). It is a VYBE cost: the provider keeps it before
-- settling, so it leaves platform_cash and lands in processing_expense. The organiser's share is never reduced by it.
alter table public.orders add column if not exists processing_fee_cents bigint check (processing_fee_cents is null or processing_fee_cents >= 0);
alter table public.payment_notifications add column if not exists fee_cents bigint;

alter table public.journal_entries drop constraint if exists journal_entries_kind_check;
alter table public.journal_entries add constraint journal_entries_kind_check check (kind in ('sale', 'refund', 'oversold_hold', 'chargeback', 'payout', 'adjustment', 'processing_fee'));
alter table public.journal_lines drop constraint if exists journal_lines_account_known;
alter table public.journal_lines add constraint journal_lines_account_known check (account in ('platform_cash', 'organizer_payable', 'promoter_payable', 'refunds_payable', 'buyer_fee_revenue', 'commission_revenue', 'vat_payable', 'chargeback_losses', 'adjustments', 'processing_expense'));

create or replace function public.record_processing_fee(p_order uuid, p_provider text, p_txn text, p_fee_cents bigint) returns boolean
language plpgsql security definer set search_path = '' as $$
declare o public.orders;
begin
  if p_fee_cents is null or p_fee_cents <= 0 or coalesce(p_txn, '') = '' then return false; end if;
  select * into o from public.orders where id = p_order;
  if not found or o.total_cents <= 0 then return false; end if;
  -- Money really arrived: paid (in any later state), or paid too late and held for an oversold refund.
  if o.status not in ('paid', 'partially_refunded', 'refunded', 'disputed')
     and not exists (select 1 from public.refunds r where r.order_id = o.id and r.kind = 'oversold') then return false; end if;
  if p_fee_cents > o.total_cents then
    perform public.raise_exception_case('processing_fee_implausible', o.id::text, 'high', jsonb_build_object('fee_cents', p_fee_cents, 'total_cents', o.total_cents), o.id);
    return false;
  end if;
  update public.orders set processing_fee_cents = p_fee_cents where id = o.id and processing_fee_cents is null;
  update public.payment_notifications set fee_cents = p_fee_cents where provider = p_provider and provider_txn_id = p_txn and fee_cents is null;
  return public.post_journal('processing_fee', 'fee:' || p_provider || ':' || p_txn, jsonb_build_object('event', o.event_id, 'order', o.id), jsonb_build_array(
    jsonb_build_object('account', 'processing_expense', 'amount', p_fee_cents),
    jsonb_build_object('account', 'platform_cash', 'amount', -p_fee_cents)), 'Provider fee (' || p_provider || ')') is not null;
end $$;

-- Finance summary now includes recorded processing costs (copied from migration 27, two lines changed).
create or replace function public.admin_ticket_finance(p_from timestamptz default now() - interval '30 days', p_to timestamptz default now()) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare r jsonb;
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  with period as (
    select l.account, e.kind, sum(l.amount_cents) as amt from public.journal_lines l join public.journal_entries e on e.id = l.entry_id
     where e.created_at >= p_from and e.created_at < p_to group by 1, 2),
  bal as (select account, sum(amount_cents) as amt from public.journal_lines group by 1)
  select jsonb_build_object(
    'basis', 'Double-entry journal: provider-confirmed payments, completed refunds, recorded payouts. Pending checkouts are excluded.',
    'collected_cents', coalesce((select sum(amt) from period where account = 'platform_cash' and kind in ('sale', 'oversold_hold')), 0),
    'gross_ticket_sales_cents', coalesce((select sum(subtotal_cents) from public.orders where paid_at >= p_from and paid_at < p_to and status in ('paid', 'partially_refunded', 'refunded', 'disputed')), 0),
    'commission_revenue_cents', -coalesce((select sum(amt) from period where account = 'commission_revenue'), 0),
    'buyer_fee_revenue_cents', -coalesce((select sum(amt) from period where account = 'buyer_fee_revenue'), 0),
    'vat_on_platform_charges_cents', -coalesce((select sum(amt) from period where account = 'vat_payable'), 0),
    'refunds_paid_cents', -coalesce((select sum(amt) from period where account = 'platform_cash' and kind = 'refund'), 0),
    'chargebacks_cents', -coalesce((select sum(amt) from period where account = 'platform_cash' and kind = 'chargeback'), 0),
    'chargeback_losses_cents', coalesce((select sum(amt) from period where account = 'chargeback_losses'), 0),
    'payouts_completed_cents', -coalesce((select sum(amt) from period where account = 'platform_cash' and kind = 'payout'), 0),
    'processing_costs_cents', coalesce((select sum(amt) from period where account = 'processing_expense'), 0),
    'net_platform_contribution_cents', -coalesce((select sum(amt) from period where account in ('commission_revenue', 'buyer_fee_revenue', 'chargeback_losses', 'adjustments', 'processing_expense')), 0),
    'processing_costs', 'PayFast fees are recorded from each payment notification (amount_fee). Ozow does not report a fee per payment, so Ozow costs are not recorded here; take them from Ozow statements.',
    'balances', jsonb_build_object(
      'cash_held_cents', coalesce((select amt from bal where account = 'platform_cash'), 0),
      'organizer_payable_cents', -coalesce((select amt from bal where account = 'organizer_payable'), 0),
      'refunds_owed_cents', -coalesce((select amt from bal where account = 'refunds_payable'), 0),
      'vat_payable_cents', -coalesce((select amt from bal where account = 'vat_payable'), 0)),
    'open_refund_obligations_cents', coalesce((select sum(ticket_amount_cents + fee_amount_cents) from public.refunds where status in ('requested', 'approved', 'processing', 'manual_required')), 0),
    'open_exceptions', (select count(*) from public.reconciliation_exceptions where status = 'open'),
    'events_awaiting_review', (select count(*) from public.events where sales_review in ('submitted', 'under_review'))
  ) into r;
  return r;
end $$;

-- ---------------------------------------------------------------- 3. payouts that could not be paid
-- An approved payout whose bank transfer was not made or bounced before it was recorded as paid: the amount becomes
-- available again (approved payouts are counted as pending), the reason is kept, and the payee is told.
create or replace function public.admin_mark_payout_failed(p_payout uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare p public.payouts;
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if coalesce(char_length(btrim(p_reason)), 0) < 5 then raise exception 'Say what went wrong'; end if;
  select * into p from public.payouts where id = p_payout for update;
  if not found or p.status <> 'approved' then raise exception 'Only an approved payout that was not paid can be marked failed'; end if;
  update public.payouts set status = 'failed', note = left(btrim(p_reason), 500), decided_at = now() where id = p_payout;
  insert into public.audit_log (actor, action, entity_type, entity_id, detail) values (auth.uid(), 'payout.failed', 'payout', p_payout, jsonb_build_object('reason', p_reason, 'amount_cents', p.amount_cents));
  perform public.notify(coalesce(p.user_id, p.requested_by), 'payout_update', null, 'payout', p.id, 'payout:' || p.id || ':failed');
end $$;

-- ---------------------------------------------------------------- 4. transactional email outbox
-- Ticket and money notifications are also emailed. Rows are written by a trigger on notifications; the email-send Edge
-- Function claims them with a worker key (kept in a schema the API cannot reach) and reports each result. Event changes
-- and cancellations are emailed only to people holding a ticket for that event.
create schema if not exists vybe_private;
revoke all on schema vybe_private from public, anon, authenticated;
create table if not exists vybe_private.workers (
  name text primary key,
  key text not null check (char_length(key) >= 32),
  url text
);
insert into vybe_private.workers (name, key) values ('email', md5(gen_random_uuid()::text) || md5(gen_random_uuid()::text)) on conflict (name) do nothing;

create table if not exists public.email_outbox (
  id bigint generated always as identity primary key,
  notification_id uuid not null unique references public.notifications(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  type text not null,
  entity_type text,
  entity_id uuid,
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed', 'skipped')),
  attempts integer not null default 0,
  last_error text check (char_length(last_error) <= 500),
  claimed_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists email_outbox_pending_idx on public.email_outbox (created_at) where status in ('pending', 'sending');
create index if not exists email_outbox_user_idx on public.email_outbox (user_id);
alter table public.email_outbox enable row level security;
revoke all on public.email_outbox from anon, authenticated;
drop policy if exists email_outbox_admin_read on public.email_outbox;
create policy email_outbox_admin_read on public.email_outbox for select to authenticated using (public.is_admin());
grant select on public.email_outbox to authenticated;

create or replace function public.trg_email_outbox() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.type in ('ticket_order', 'refund_update', 'sales_review', 'payout_update', 'event_feedback')
     or (new.type in ('event_update', 'event_cancelled') and new.entity_type = 'event'
         and exists (select 1 from public.tickets t where t.event_id = new.entity_id and t.owner = new.user_id and t.status in ('valid', 'used'))) then
    insert into public.email_outbox (notification_id, user_id, type, entity_type, entity_id) values (new.id, new.user_id, new.type, new.entity_type, new.entity_id)
    on conflict (notification_id) do nothing;
  end if;
  return null;
end $$;
drop trigger if exists email_outbox on public.notifications;
create trigger email_outbox after insert on public.notifications for each row execute function public.trg_email_outbox();

create or replace function public.email_worker_ok(p_key text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select w.key = p_key from vybe_private.workers w where w.name = 'email'), false) and coalesce(char_length(p_key), 0) >= 32;
$$;

-- Claims up to p_limit emails (skipping rows another worker holds), with what the message needs and nothing more.
create or replace function public.email_worker_claim(p_key text, p_limit integer default 20) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare out jsonb;
begin
  if not public.email_worker_ok(p_key) then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.email_outbox set status = 'failed', last_error = coalesce(last_error, 'Gave up after 5 attempts')
   where status in ('pending', 'sending') and attempts >= 5;
  with picked as (
    select id from public.email_outbox
     where (status = 'pending' or (status = 'sending' and claimed_at < now() - interval '10 minutes')) and attempts < 5
     order by created_at limit least(greatest(coalesce(p_limit, 20), 1), 50) for update skip locked),
  claimed as (
    update public.email_outbox x set status = 'sending', attempts = x.attempts + 1, claimed_at = now()
      from picked where x.id = picked.id returning x.*)
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', c.id, 'type', c.type, 'entity_type', c.entity_type, 'entity_id', c.entity_id,
      'email', u.email, 'name', coalesce(nullif(p.display_name, ''), p.username),
      'event_title', coalesce(ev.title, oev.title),
      'order_status', o.status, 'order_total_cents', o.total_cents,
      'payout_status', po.status, 'payout_amount_cents', po.amount_cents,
      'review_status', ev.sales_review)), '[]'::jsonb)
    into out
    from claimed c
    join public.profiles p on p.id = c.user_id
    left join auth.users u on u.id = c.user_id
    left join public.events ev on c.entity_type = 'event' and ev.id = c.entity_id
    left join public.orders o on c.entity_type = 'order' and o.id = c.entity_id
    left join public.events oev on oev.id = o.event_id
    left join public.payouts po on c.entity_type = 'payout' and po.id = c.entity_id;
  return out;
end $$;

create or replace function public.email_worker_done(p_key text, p_id bigint, p_status text, p_error text default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.email_worker_ok(p_key) then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_status not in ('sent', 'pending', 'failed', 'skipped') then raise exception 'bad status'; end if;
  update public.email_outbox set status = p_status, last_error = left(p_error, 500), sent_at = case when p_status = 'sent' then now() end
   where id = p_id and status = 'sending';
end $$;

-- Every minute while something is waiting, if pg_cron and pg_net are available and the worker URL has been set:
--   update vybe_private.workers set url = 'https://<project-ref>.supabase.co/functions/v1/email-send' where name = 'email';
do $$ begin
  begin create extension if not exists pg_net; exception when others then null; end;
  begin create extension if not exists pg_cron; exception when others then null; end;
  if exists (select 1 from pg_extension where extname = 'pg_cron') and exists (select 1 from pg_extension where extname = 'pg_net') then
    perform cron.schedule('vybe-email', '* * * * *', $job$
      select net.http_post(url := w.url, body := '{}'::jsonb,
                           headers := jsonb_build_object('Authorization', 'Bearer ' || w.key, 'Content-Type', 'application/json'))
        from vybe_private.workers w
       where w.name = 'email' and w.url is not null
         and exists (select 1 from public.email_outbox where status in ('pending', 'sending') and attempts < 5)
    $job$);
  end if;
exception when others then null;
end $$;

-- ---------------------------------------------------------------- grants
revoke execute on function public.record_processing_fee(uuid, text, text, bigint), public.email_worker_ok(text), public.email_worker_claim(text, integer),
  public.email_worker_done(text, bigint, text, text) from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.record_processing_fee(uuid, text, text, bigint), public.email_worker_claim(text, integer), public.email_worker_done(text, bigint, text, text) to service_role;
    grant usage on schema vybe_private to service_role;
  end if;
end $$;
revoke execute on function public.admin_mark_payout_failed(uuid, text) from public, anon;
grant execute on function public.admin_mark_payout_failed(uuid, text) to authenticated;

do $$ declare f record; begin
  for f in select p.oid::regprocedure as sig from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prorettype = 'trigger'::regtype loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
  end loop;
end $$;

-- ---------------------------------------------------------------- 5. what a buyer pays on top, before paying
-- The buyer-facing part of the terms an event sells under (never the organiser's commission), so checkout can show the
-- full price up front. Same lookup the server uses when it prices the order.
create or replace function public.buyer_fee_terms(p_event uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when public.can_view_event_id(p_event) then
    (select jsonb_build_object('buyer_fee_enabled', f.buyer_fee_enabled, 'buyer_fee_bps', f.buyer_fee_bps, 'buyer_fee_fixed_cents', f.buyer_fee_fixed_cents,
                               'buyer_fee_per_ticket_cents', f.buyer_fee_per_ticket_cents) from public.fee_policy_for(p_event) f) end;
$$;
revoke execute on function public.buyer_fee_terms(uuid) from public, anon;
grant execute on function public.buyer_fee_terms(uuid) to authenticated;
