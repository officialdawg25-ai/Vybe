-- 04-refunds.sql: run in filename order (live streaming, finance). Re-runnable.
-- ------------------------------------------------------------------ refunds, disputes, payouts (tables first; the ledger refers to them)
create table if not exists public.refunds (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete restrict,
  requested_by uuid not null references public.profiles(id) on delete restrict,
  kind text not null check (kind in ('buyer_request','organizer','event_cancelled','admin')),
  status text not null default 'requested' check (status in ('requested','approved','processing','succeeded','failed','rejected','manual_required')),
  ticket_ids uuid[] not null default '{}',
  ticket_amount_cents bigint not null check (ticket_amount_cents >= 0),
  fee_amount_cents bigint not null default 0 check (fee_amount_cents >= 0),
  reason text not null default '' check (char_length(reason) <= 500),
  provider text,
  provider_ref text,
  error text,
  decided_by uuid references public.profiles(id) on delete set null,
  decided_at timestamptz,
  processed_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index if not exists refunds_one_active on public.refunds (order_id) where status in ('requested','approved','processing','manual_required');

create index if not exists refunds_status_idx on public.refunds (status, created_at);

create table if not exists public.disputes (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete restrict,
  status text not null default 'open' check (status in ('open','won','lost')),
  amount_cents bigint not null check (amount_cents > 0),
  reason text not null default '' check (char_length(reason) <= 500),
  evidence text not null default '' check (char_length(evidence) <= 4000),
  opened_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create unique index if not exists disputes_one_open on public.disputes (order_id) where status = 'open';

create table if not exists public.buyer_flags (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  reason text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.payout_accounts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid unique references public.organizations(id) on delete cascade,
  user_id uuid unique references public.profiles(id) on delete cascade,
  holder text not null check (char_length(holder) between 2 and 120),
  bank text not null check (char_length(bank) between 2 and 80),
  account_last4 text not null check (account_last4 ~ '^[0-9]{2,4}$'),
  details_enc text not null,
  status text not null default 'pending' check (status in ('pending','verified','rejected')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((organization_id is not null) <> (user_id is not null))
);
