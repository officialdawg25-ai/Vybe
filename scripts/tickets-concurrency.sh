#!/usr/bin/env bash
# Concurrency checks for VYBE Tickets against a REAL PostgreSQL server (PGlite in the unit suite has one connection, so it
# cannot race). Starts a throwaway cluster, applies every migration, then uses pgbench to run many clients at once:
#   1. 40 buyers race for the last 5 tickets           → exactly 5 units held, never more
#   2. one buyer double-submits the same checkout x25  → one order
#   3. the same payment webhook delivered 25 times at once → one set of tickets, one sale journal
#   4. 30 scanners redeem one ticket at the same moment → exactly one admission
#   5. 20 simultaneous payout requests for one payee   → one payout
#   6. 20 simultaneous refund requests for one order   → one refund
# Usage: scripts/tickets-concurrency.sh   (needs PostgreSQL 16 server binaries; runs the cluster as the postgres user)
set -euo pipefail
BIN=${PG_BIN:-/usr/lib/postgresql/16/bin}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d /tmp/vybe-pg-XXXXXX)
PORT=${PG_PORT:-54329}
chown postgres "$WORK" 2>/dev/null || true
as_pg() { if [ "$(id -u)" = 0 ]; then runuser -u postgres -- "$@"; else "$@"; fi; }
cleanup() { as_pg "$BIN/pg_ctl" -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

as_pg "$BIN/initdb" -D "$WORK/data" -A trust -U postgres >/dev/null
as_pg "$BIN/pg_ctl" -D "$WORK/data" -o "-p $PORT -k $WORK -c max_connections=200 -c fsync=off" -l "$WORK/log" start >/dev/null
export PGOPTIONS="-c client_min_messages=warning"
PSQL=(as_pg "$BIN/psql" -h "$WORK" -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -qAt)
PGBENCH=(as_pg "$BIN/pgbench" -h "$WORK" -p "$PORT" -U postgres -n -t 1)

# Supabase stand-ins (same as tests/db/rls.test.ts) and every migration, in order.
node -e "const s=require('fs').readFileSync('$ROOT/tests/db/rls.test.ts','utf8'); process.stdout.write(s.match(/const STUBS = \`([\s\S]*?)\`/)[1])" > "$WORK/stubs.sql"
"${PSQL[@]}" -f "$WORK/stubs.sql" >/dev/null
for f in "$ROOT"/supabase/migrations/*.sql; do cp "$f" "$WORK/m.sql"; chown postgres "$WORK/m.sql" 2>/dev/null || true; "${PSQL[@]}" -f "$WORK/m.sql" >/dev/null; done
echo "schema: $(ls "$ROOT"/supabase/migrations/*.sql | wc -l) migrations applied to PostgreSQL $("${PSQL[@]}" -c 'show server_version')"

# Fixtures with fixed ids: a host, an admin, 40 buyers, an approved event with 5 tickets left.
"${PSQL[@]}" <<'SQL' >/dev/null
insert into auth.users (id, email, raw_user_meta_data) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'host@x', '{"username":"chost"}'), ('aaaaaaaa-0000-4000-8000-000000000002', 'admin@x', '{"username":"cadmin"}'),
  ('aaaaaaaa-0000-4000-8000-000000000003', 'admin2@x', '{"username":"cadmin2"}');
insert into auth.users (id, email, raw_user_meta_data)
  select ('bbbbbbbb-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, 'b' || g || '@x', jsonb_build_object('username', 'cbuyer' || g) from generate_series(1, 40) g;
insert into public.staff (user_id, role) values ('aaaaaaaa-0000-4000-8000-000000000002', 'admin'), ('aaaaaaaa-0000-4000-8000-000000000003', 'admin');
insert into public.events (id, host, title, starts_at, timezone, visibility) values ('cccccccc-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'Race night', now() + interval '10 days', 'UTC', 'public');
update public.events set sales_review = 'approved' where id = 'cccccccc-0000-4000-8000-000000000001';
insert into public.ticket_types (id, event_id, name, price_cents, quantity_total, max_per_order) values ('dddddddd-0000-4000-8000-000000000001', 'cccccccc-0000-4000-8000-000000000001', 'GA', 20000, 5, 1);
SQL
fail=0
check() { if [ "$2" = "$3" ]; then echo "✓ $1 ($2)"; else echo "✗ $1: expected $3, got $2"; fail=1; fi; }

# 1. 40 buyers race for 5 tickets.
cat > "$WORK/race.sql" <<'SQL'
\set n random(1, 1)
set role authenticated;
select set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-4000-8000-' || lpad(:client_id + 1 || '', 12, '0'), false);
do $$ begin perform public.create_order('cccccccc-0000-4000-8000-000000000001', '[{"ticket_type_id":"dddddddd-0000-4000-8000-000000000001","qty":1}]', 'payfast', 'race-' || gen_random_uuid()); exception when others then null; end $$;
reset role;
SQL
chown postgres "$WORK/race.sql" 2>/dev/null || true
"${PGBENCH[@]}" -c 40 -j 8 -f "$WORK/race.sql" postgres >/dev/null 2>&1
check "40 buyers racing for 5 tickets hold exactly 5" "$("${PSQL[@]}" -c "select public.ticket_units_taken('dddddddd-0000-4000-8000-000000000001')")" 5
check "orders created in the race" "$("${PSQL[@]}" -c "select count(*) from public.orders where event_id = 'cccccccc-0000-4000-8000-000000000001'")" 5

# 2. One buyer, same idempotency key, 25 concurrent submits (stock freed first by expiring the race orders).
"${PSQL[@]}" -c "update public.orders set status = 'expired' where event_id = 'cccccccc-0000-4000-8000-000000000001'" >/dev/null
cat > "$WORK/idem.sql" <<'SQL'
set role authenticated;
select set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-4000-8000-000000000040', false);
do $$ begin perform public.create_order('cccccccc-0000-4000-8000-000000000001', '[{"ticket_type_id":"dddddddd-0000-4000-8000-000000000001","qty":1}]', 'payfast', 'same-key-12345'); exception when others then null; end $$;
reset role;
SQL
chown postgres "$WORK/idem.sql" 2>/dev/null || true
"${PGBENCH[@]}" -c 25 -j 8 -f "$WORK/idem.sql" postgres >/dev/null 2>&1
check "25 concurrent submits with one idempotency key make one order" "$("${PSQL[@]}" -c "select count(*) from public.orders where idempotency_key = 'same-key-12345'")" 1

# 3. The same verified payment notification processed 25 times at once.
OID=$("${PSQL[@]}" -c "select id from public.orders where idempotency_key = 'same-key-12345'")
TOTAL=$("${PSQL[@]}" -c "select total_cents from public.orders where id = '$OID'")
cat > "$WORK/hook.sql" <<SQL
do \$\$ begin perform public.fulfill_order('$OID', 'payfast', 'pf-race-1', $TOTAL, 'cc'); exception when others then null; end \$\$;
SQL
chown postgres "$WORK/hook.sql" 2>/dev/null || true
"${PGBENCH[@]}" -c 25 -j 8 -f "$WORK/hook.sql" postgres >/dev/null 2>&1
check "25 simultaneous deliveries of one payment issue one ticket" "$("${PSQL[@]}" -c "select count(*) from public.tickets where order_id = '$OID'")" 1
check "…and post one sale journal" "$("${PSQL[@]}" -c "select count(*) from public.journal_entries where order_id = '$OID' and kind = 'sale'")" 1
check "…and one organiser sale entry" "$("${PSQL[@]}" -c "select count(*) from public.ledger_entries where order_id = '$OID' and kind = 'sale'")" 1
check "the journal balances" "$("${PSQL[@]}" -c "select coalesce(sum(amount_cents), 0) from public.journal_lines")" 0

# 4. 30 scanners redeem the same ticket at the same moment (all assigned to the event).
CODE=$("${PSQL[@]}" -c "select code from public.tickets where order_id = '$OID'")
"${PSQL[@]}" -c "insert into public.event_staff (event_id, user_id, added_by) select 'cccccccc-0000-4000-8000-000000000001', ('bbbbbbbb-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, 'aaaaaaaa-0000-4000-8000-000000000001' from generate_series(1, 30) g" >/dev/null
cat > "$WORK/scan.sql" <<SQL
set role authenticated;
select set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-4000-8000-' || lpad(:client_id + 1 || '', 12, '0'), false);
select public.admit_ticket('cccccccc-0000-4000-8000-000000000001', '$CODE');
reset role;
SQL
chown postgres "$WORK/scan.sql" 2>/dev/null || true
"${PGBENCH[@]}" -c 30 -j 8 -f "$WORK/scan.sql" postgres >/dev/null 2>&1
check "30 simultaneous scans of one ticket admit exactly one" "$("${PSQL[@]}" -c "select count(*) from public.ticket_scans where result = 'ok'")" 1
check "…and the other 29 are told it was already used" "$("${PSQL[@]}" -c "select count(*) from public.ticket_scans where result = 'already_used'")" 29

# 5. 20 payout requests for one payee at once (event over, settlement hold passed, verified account outside the cooling-off).
"${PSQL[@]}" <<'SQL' >/dev/null
update public.events set starts_at = now() - interval '10 days', ends_at = now() - interval '9 days' where id = 'cccccccc-0000-4000-8000-000000000001';
update public.platform_config set payout_min_cents = 100;
insert into public.payout_accounts (user_id, holder, bank, account_last4, details_enc, status, updated_at) values ('aaaaaaaa-0000-4000-8000-000000000001', 'Host', 'FNB', '1234', 'c', 'verified', now() - interval '10 days');
SQL
cat > "$WORK/payout.sql" <<'SQL'
set role authenticated;
select set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-4000-8000-000000000001', false);
do $$ begin perform public.request_payout(null); exception when others then null; end $$;
reset role;
SQL
chown postgres "$WORK/payout.sql" 2>/dev/null || true
"${PGBENCH[@]}" -c 20 -j 8 -f "$WORK/payout.sql" postgres >/dev/null 2>&1
check "20 simultaneous payout requests create one payout" "$("${PSQL[@]}" -c "select count(*) from public.payouts")" 1

# 6. 20 refund requests for one order at once (a second paid order, still before the event's refund window).
"${PSQL[@]}" <<'SQL' >/dev/null
insert into public.events (id, host, title, starts_at, timezone, visibility) values ('cccccccc-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000001', 'Refund night', now() + interval '20 days', 'UTC', 'public');
update public.events set sales_review = 'approved' where id = 'cccccccc-0000-4000-8000-000000000002';
insert into public.ticket_types (id, event_id, name, price_cents, quantity_total, max_per_order) values ('dddddddd-0000-4000-8000-000000000002', 'cccccccc-0000-4000-8000-000000000002', 'GA', 20000, 10, 2);
set role authenticated;
select set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-4000-8000-000000000039', false);
select public.create_order('cccccccc-0000-4000-8000-000000000002', '[{"ticket_type_id":"dddddddd-0000-4000-8000-000000000002","qty":2}]', 'payfast', 'refund-race-1');
reset role;
SQL
OID2=$("${PSQL[@]}" -c "select id from public.orders where idempotency_key = 'refund-race-1'")
TOTAL2=$("${PSQL[@]}" -c "select total_cents from public.orders where id = '$OID2'")
"${PSQL[@]}" -c "select public.fulfill_order('$OID2', 'payfast', 'pf-race-2', $TOTAL2, 'cc')" >/dev/null
cat > "$WORK/refund.sql" <<SQL
set role authenticated;
select set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-4000-8000-000000000039', false);
do \$\$ begin perform public.request_refund('$OID2', 'race'); exception when others then null; end \$\$;
reset role;
SQL
chown postgres "$WORK/refund.sql" 2>/dev/null || true
"${PGBENCH[@]}" -c 20 -j 8 -f "$WORK/refund.sql" postgres >/dev/null 2>&1
check "20 simultaneous refund requests for one order create one refund" "$("${PSQL[@]}" -c "select count(*) from public.refunds where order_id = '$OID2'")" 1

"${PSQL[@]}" -c "set request.jwt.claim.sub = ''; select public.finance_reconcile()" >/dev/null
check "reconciliation after the races: no ledger disagreements" "$("${PSQL[@]}" -c "select count(*) from public.reconciliation_exceptions where status = 'open' and kind in ('journal_unbalanced','payable_mismatch','ticket_count_mismatch','missing_sale_journal')")" 0

[ $fail = 0 ] && echo "All concurrency checks passed" || { echo "Some concurrency checks FAILED"; exit 1; }
