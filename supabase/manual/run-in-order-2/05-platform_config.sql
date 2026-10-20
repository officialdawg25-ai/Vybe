-- 05-platform_config.sql: run in filename order (voice notes, onboarding data, events near you, tickets). Re-runnable.
-- ------------------------------------------------------------ ticketing
-- Platform fee settings live in one row that clients can never read or write (only definer functions and the service role).
create table if not exists public.platform_config (
  id boolean primary key default true check (id),
  fee_bps integer not null default 500 check (fee_bps between 0 and 3000),          -- 5.00 % service fee added to the buyer's total
  fee_fixed_cents integer not null default 300 check (fee_fixed_cents between 0 and 5000), -- + R3.00 per paid order
  hold_minutes integer not null default 15 check (hold_minutes between 5 and 60),
  max_tickets_per_order integer not null default 20 check (max_tickets_per_order between 1 and 100)
);

insert into public.platform_config (id) values (true) on conflict (id) do nothing;

alter table public.platform_config enable row level security;

revoke all on public.platform_config from anon, authenticated;

create table if not exists public.ticket_types (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  description text not null default '' check (char_length(description) <= 300),
  kind text not null default 'single' check (kind in ('single','group')),
  group_size integer not null default 1 check (group_size between 1 and 20),       -- tickets issued per unit bought
  price_cents integer not null check (price_cents between 0 and 5000000),         -- per unit, ZAR cents
  currency text not null default 'ZAR' check (currency = 'ZAR'),
  quantity_total integer not null check (quantity_total between 1 and 100000),    -- units for sale
  max_per_order integer not null default 10 check (max_per_order between 1 and 20),
  sales_start timestamptz,
  sales_end timestamptz,
  status text not null default 'active' check (status in ('active','paused')),
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  check ((kind = 'single' and group_size = 1) or kind = 'group'),
  check (sales_end is null or sales_start is null or sales_end > sales_start)
);

create index if not exists ticket_types_event_idx on public.ticket_types (event_id, sort);

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  buyer uuid not null references public.profiles(id) on delete restrict,
  event_id uuid not null references public.events(id) on delete restrict,
  status text not null default 'pending' check (status in ('pending','paid','failed','cancelled','expired','refunded')),
  provider text check (provider in ('payfast','ozow','free')),
  provider_ref text,
  subtotal_cents bigint not null check (subtotal_cents >= 0),
  fee_cents bigint not null default 0 check (fee_cents >= 0),
  total_cents bigint not null check (total_cents >= 0),
  currency text not null default 'ZAR' check (currency = 'ZAR'),
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 80),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  paid_at timestamptz,
  unique (buyer, idempotency_key),
  check (total_cents = subtotal_cents + fee_cents)
);

create index if not exists orders_buyer_idx on public.orders (buyer, created_at desc);

create index if not exists orders_event_idx on public.orders (event_id, status);
