drop policy if exists verification_plans_admin on public.verification_plans;

create policy verification_plans_admin on public.verification_plans for all to authenticated using (public.is_admin()) with check (public.is_admin());

revoke all on public.verification_plans from anon, authenticated;

grant select, insert, update, delete on public.verification_plans to authenticated;

-- Starting prices only: administrators set the real ones in Admin → Verification.
insert into public.verification_plans (id, label, days, price_cents, sort) values
  ('monthly', 'VYBE Verified · 1 month', 30, 4900, 10), ('yearly', 'VYBE Verified · 1 year', 365, 49900, 20)
on conflict (id) do nothing;

create table if not exists public.badge_orders (
  id uuid primary key default gen_random_uuid(),
  buyer uuid not null references public.profiles(id) on delete restrict,
  plan_id text not null references public.verification_plans(id),
  days integer not null,
  total_cents bigint not null check (total_cents >= 100),
  provider text not null check (provider in ('payfast', 'ozow')),
  provider_ref text,
  status text not null default 'pending' check (status in ('pending', 'paid', 'failed', 'cancelled', 'expired')),
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 80),
  ip_hash text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  paid_at timestamptz,
  unique (buyer, idempotency_key)
);

create unique index if not exists badge_orders_ref_key on public.badge_orders (provider, provider_ref) where provider_ref is not null;

create index if not exists badge_orders_buyer_idx on public.badge_orders (buyer, created_at desc);

alter table public.badge_orders enable row level security;

drop policy if exists badge_orders_own on public.badge_orders;

create policy badge_orders_own on public.badge_orders for select to authenticated using (buyer = auth.uid() or public.is_admin());

revoke all on public.badge_orders from anon, authenticated;

grant select on public.badge_orders to authenticated;
