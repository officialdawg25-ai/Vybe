create table if not exists public.payouts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete restrict,
  user_id uuid references public.profiles(id) on delete restrict,
  amount_cents bigint not null check (amount_cents > 0),
  status text not null default 'requested' check (status in ('requested','approved','paid','rejected','failed')),
  requested_by uuid not null references public.profiles(id) on delete restrict,
  decided_by uuid references public.profiles(id) on delete set null,
  bank_reference text,
  note text not null default '' check (char_length(note) <= 500),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  paid_at timestamptz,
  check ((organization_id is not null) <> (user_id is not null))
);

create index if not exists payouts_status_idx on public.payouts (status, created_at);

create table if not exists public.ledger_entries (
  id bigint generated always as identity primary key,
  event_id uuid references public.events(id) on delete restrict,
  organization_id uuid references public.organizations(id) on delete restrict,
  payee_user uuid references public.profiles(id) on delete restrict,
  order_id uuid references public.orders(id) on delete restrict,
  refund_id uuid references public.refunds(id) on delete restrict,
  payout_id uuid references public.payouts(id) on delete restrict,
  dispute_id uuid references public.disputes(id) on delete restrict,
  kind text not null check (kind in ('sale','refund','chargeback','payout','adjustment')),
  amount_cents bigint not null,                    -- + increases what the payee is owed, − decreases it
  note text not null default '',
  created_at timestamptz not null default now(),
  check ((organization_id is not null) <> (payee_user is not null))
);

create index if not exists ledger_org_idx on public.ledger_entries (organization_id, created_at);

create index if not exists ledger_user_idx on public.ledger_entries (payee_user, created_at);

create index if not exists ledger_event_idx on public.ledger_entries (event_id);

create or replace function public.trg_ledger_immutable() returns trigger language plpgsql set search_path = '' as $$
begin raise exception 'ledger entries are append-only'; end $$;

drop trigger if exists ledger_immutable on public.ledger_entries;

create trigger ledger_immutable before update or delete on public.ledger_entries for each row execute function public.trg_ledger_immutable();
