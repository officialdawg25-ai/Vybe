# VYBE Tickets — implementation report (increment 1: migration 27; increment 2: migration 28)

Status labels: **VERIFIED** (run and inspected), **PARTIALLY VERIFIED**, **INFERRED**, **PROPOSED**, **BLOCKED**.

## A. Repository baseline (before this work)

| Item | Finding | Status |
| --- | --- | --- |
| Repository / branch | `officialdawg25-ai/Vybe`, work on `claude/share-memory-reel-ux-t1gvap` restarted from `main` @ `fd5d777` (PR #23 merged) | VERIFIED |
| Stack | React 18 + Vite + TypeScript, Supabase (Postgres 17, RLS, Edge Functions), Cloudflare Worker `vybe` | VERIFIED |
| Production database | Supabase project `ukgtcungmisthtmknxni` (only project on the account), migrations 1–26 applied | VERIFIED (read-only queries) |
| Live ticketing data | 5 events (3 active), 3 paid ticket types, **1 order (cancelled, PayFast), 0 tickets, 0 refunds, 0 payouts, 0 payout accounts, 0 ledger rows** | VERIFIED |
| Live fee config | buyer service fee 5 % + R3.00 per order, VAT not registered, settlement hold 3 days, min payout R100 | VERIFIED |
| `pg_cron` | **not installed**: order-expiry and stuck-refund sweeps never run on schedule | VERIFIED |
| Existing ticketing (migrations 6, 8) | ticket types; orders with buyer idempotency keys; row-locked inventory; PayFast + Ozow checkout (signature, merchant, amount and server-to-server checks); refunds (PayFast card refunds by API, others manual); disputes; encrypted payout accounts; admin-approved manual payouts; append-only single-entry organiser ledger; receipts/tax invoices; one-transfer-to-friends; door check-in | VERIFIED (code read, tests) |
| Identity / roles | Supabase Auth; `staff` (moderator/admin); organisation roles owner/admin/editor; `can_manage_event` = host or org owner/admin/editor | VERIFIED |
| Notifications | trigger/definer-written `notifications` with dedupe keys | VERIFIED |
| Edge functions deployed | pay-start, payfast-itn, ozow-notify, refund-process, payout-account (+ others), all ACTIVE | VERIFIED |
| Provider credentials | Edge Function secrets cannot be read from here; whether PayFast/Ozow are configured (sandbox or live) is unknown | BLOCKED (needs owner) |

### Gaps found in the existing implementation

1. No review of events before **paid** sales: any member could list and sell (VERIFIED).
2. Fees lived in one mutable config row; orders kept amounts but not the terms or basis they were priced under (VERIFIED).
3. Single-entry ledger only; VYBE's own revenue and money held were never booked (VERIFIED).
4. **Money taken after a hold lapsed on a sold-out type was marked "failed" with no refund obligation** — the payment fell off the books (VERIFIED bug, fixed).
5. **A hold that lapsed but was not swept yet still skipped the stock re-check** when its payment arrived → possible oversell (VERIFIED bug, fixed; matters more because pg_cron is absent).
6. Payout "available" ignored refunds already approved → organisers could withdraw money owed back to buyers (VERIFIED bug, fixed).
7. Payout requests not serialised; approver could equal requester; one admin could approve and confirm any amount; no pause after bank-detail changes (VERIFIED).
8. Every event manager could read all ticket codes (the door credential) through the API (VERIFIED, fixed).
9. Door check-in not bound to an event; no scan audit; no door-staff role (VERIFIED, fixed).
10. Verified payment notifications not persisted; no reconciliation queue (VERIFIED, fixed).
11. Lineup claims unverified and unversioned (VERIFIED, fixed).
12. Migration 26's `trg_close_friends_limit` executable over the API (advisor finding; harmless but fixed).
13. `events` has a table-wide INSERT grant → new trust columns need a trigger guard (handled).

## B. Implementation summary

**Migration** `supabase/migrations/20261109000027_tickets_trust_ledger.sql` (+ `supabase/manual/update-27/run-me.sql`, all-or-nothing with checks).

| Area | What now exists |
| --- | --- |
| Fee policies | `fee_policies` (platform / organisation / event scope, versioned, immutable, effective dates); `fee_policy_for`, `price_order` (integer cents, half-up, VAT carved from VYBE's own charges), `admin_create_fee_policy` (reason required, retires the previous version at the new start), `preview_pricing`, `event_fee_terms` (managers see their own terms). Platform **v1 = the live terms** (buyer fee 5 % + R3, no commission), so pricing does not change on deploy. Orders store `fee_policy_id`, full `pricing` snapshot, `commission_cents`, `commission_vat_cents`, `organizer_net_cents`. |
| Commission base | Ticket face value actually charged (after discounts), excluding the buyer fee; recorded on every policy and snapshot. |
| Sales review | `events.sales_review` state machine (not_submitted → submitted → under_review → approved; rejected; suspended ↔ approved), `event_evidence`, append-only `event_sales_decisions`, `submit_event_for_sales_review`, `admin_review_event_sales` (reasons required for refusals; reviewers cannot act on events they host or belong to), `admin_decide_evidence`. `create_order` refuses paid tickets until approved (free tickets unaffected); `pay-start` refuses to take money if sales were suspended or the event cancelled after the order. Insert trigger prevents self-approval. |
| Lineup | status pending/confirmed/changed/disputed/cancelled (admin-set with a source note), editing a confirmed act marks it CHANGED, full `event_lineup_history`. Public badges on the event page. |
| Journal | `journal_entries` + `journal_lines` (double entry, balanced per entry at commit by a deferred constraint trigger, append-only, idempotency key per entry). Accounts: platform_cash, organizer_payable (per payee), refunds_payable, buyer_fee_revenue, commission_revenue, vat_payable, chargeback_losses, adjustments. Posted by sales, refunds (commission returned in proportion under the order's own terms), oversold holds, chargebacks (organiser bears up to their net, VYBE the rest), payouts, adjustments. Existing paid orders back-filled. |
| Payment notifications | `payment_notifications` unique per (provider, transaction, status) with outcome; handlers record after signature/merchant checks and before acting; amount mismatches / failed confirmation open **critical/high** cases. Best effort: never blocks settlement (which is idempotent). |
| Reconciliation | `reconciliation_exceptions` queue; `finance_reconcile()` checks journal balance, missing sale entries, ticket count per order, paid without provider reference, organiser sub-ledger vs journal per payee, stuck refunds, payouts without reference; also releases lapsed holds. `admin_resolve_exception` (what was done, recorded). |
| Admission | `event_staff` (door team per event), `can_scan_event`, `admit_ticket(event, code)` (atomic, event-bound, checks ticket/order/refund/cancellation state, logs every attempt to `ticket_scans`, throttles bursts of bad codes); old `check_in_ticket` routed through it. Ticket codes: 80 bits from the CSPRNG; **column privilege removed** — only the holder gets their code via `my_ticket_code`. |
| Payouts | committed refunds deducted from available; advisory lock per payee; cooling-off after bank-detail changes (default 72 h); approver ≠ requester; above `payout_dual_control_cents` (default R5,000) confirmer ≠ approver; balance re-checked at confirmation; journal posting. |
| Reporting | `admin_ticket_finance` from the journal: collected, gross, commission, buyer fees, VAT, refunds, chargebacks, payouts, net contribution, balances; states its basis; says processing costs are **not recorded**. |
| Notifications | `ticket_order` (paid / failed), `refund_update`, `sales_review`, `payout_update`, deduplicated by key. |

**Frontend**: `src/lib/pricing.ts` (mirror of `price_order` + labelled scenario calculator), `src/lib/trust.ts`; event page "Ticket sales & door" panel (`components/tickets/SalesReview.tsx`); buyer view explains the wait; shared `DoorScanner` + `/app/scan/:eventId` for door staff; org portal check-in now per event; My Tickets fetches codes via `my_ticket_code`, shows refunded, lists door duties; **Admin → Tickets & Trust** (`/admin/trust`: review queue with evidence and lineup verification, versioned terms + calculator, money & reconciliation, payment notifications); Admin → Finance fee fields replaced by a link to Terms, new payout/review settings; notification texts.

**Edge functions**: `_shared/handlers/pay.ts` records notifications and outcomes; pay-start sales gate.

## C. Financial implementation

* Commission: per policy; v1 = 0 % commission + buyer fee (live terms preserved). Proposed default in the brief (5 % organiser commission, buyer fees off) is **one admin action** (Terms → new platform version) — not done automatically because it changes what real buyers and organisers pay. PROPOSED, needs your decision.
* Providers: PayFast (cards; refunds by API) and Ozow (EFT) — capabilities as already integrated. **No provider payout/split API is integrated**; payouts are bank transfers recorded with a reference under maker-checker. Real-money marketplace settlement (holding organiser funds) needs a provider arrangement and legal review: BLOCKED.
* Processing costs are not imported (no statement integration): reported as "not recorded", never estimated in actuals.

## D. Verification evidence (all run in this session)

| Command | Result |
| --- | --- |
| `npx tsc --noEmit` | pass |
| `npx vitest run` | **448 passed** (23 files) — includes 18 new migration-27 DB tests (PGlite), 5 new payment-handler tests, 8 pricing unit tests; the SQL and TypeScript pricing agree to the cent across terms × amounts × VAT |
| `npm run build` | pass |
| `scripts/tickets-concurrency.sh` (real PostgreSQL 16 + pgbench) | **12/12 pass**: 40 buyers for 5 tickets → exactly 5; 25 concurrent same-key submits → 1 order; 25 simultaneous deliveries of one payment → 1 ticket, 1 sale journal, 1 ledger row; 30 simultaneous scans → 1 admission, 29 "already used"; 20 payout requests → 1; 20 refund requests → 1; reconciliation clean afterwards |
| Mutation check | same script with the inventory row lock removed: **18 holds for 5 tickets → test fails** (the test detects overselling) |
| `node scripts/sql-updates.mjs` + apply update-27 to a copy at migration 26 | every check row true; re-run safe |
| `scripts/round9-check.mjs` (browser, mocked backend) | all pass: organiser panel, buyer wait state, scanner answers (codes truncated on screen), admin review / terms / money |

Not tested: real PayFast/Ozow sandbox round trips (credentials unavailable here — BLOCKED); multi-device offline admission (not built, by design); load beyond 40 concurrent clients; email delivery (in-app notifications only).

## D2. Increment 2 (migration 28): risk, reviews, referrals, exports

**Migration** `supabase/migrations/20261110000028_tickets_risk_reviews_referrals.sql` (+ `supabase/manual/update-28/run-me.sql`, all-or-nothing, needs update 27 first).

| Area | What now exists | Status |
| --- | --- | --- |
| **Security fix (pre-existing since migration 8)** | `can_view_finance` returned NULL rather than false for outsiders, and `if not NULL` lets the call through. Any signed-in member could read another payee's `payout_balance` and call `request_payout` for them (it still needed that payee's verified bank account, so money could not be redirected). Fixed with `coalesce`; regression test added. | VERIFIED (bug reproduced and fixed in tests); **live today until update 28 is applied**. Live impact is low: 0 payout accounts, 0 sales. |
| Risk engine | `risk_rules` (11 explainable rules: threshold, window, action; admin-tunable, audited) and `risk_cases` (one live case per rule and subject, with evidence, appeal and decision note). Signals come from triggers on orders, refunds, disputes, payout accounts, events (duplicate title and time), scans and lineup edits, and from review bursts and self-referral. **Only two actions block anything automatically, and only while the case is open or appealed:** `PAUSE_PAYOUT` (payout requests and paid-marking refused) and `RESTRICT_ACCOUNT` (new orders refused). Every other action queues the case for a person. Organisers see that a hold exists and can appeal, but never see the rule behind it. | VERIFIED (DB tests) |
| Material changes | A date move of more than 1 h, or a venue, address or city change, marks the event as changed (audited; holders are notified by the existing event-update trigger). Organisers can also declare a change with a note, which notifies holders. Buyers who paid before the change get their refund **approved straight away**, with the booking fee included when the whole unused order is refunded. | VERIFIED |
| Reviews | Allowed only for ticket holders whose order was not fully refunded, after the event and within 60 days. Organisers and their team cannot review. "Attended" means the ticket was scanned. No average is shown below 3 reviews. Organisers get one public reply. Staff can hide a review (reason required, audited) and reviews are reportable through the normal moderation queue. | VERIFIED |
| Complaints | Private between the buyer and the event managers: reply, then the buyer can escalate to VYBE, and an admin closes it with a resolution the buyer is told about. Rate-limited to 5 a day. These use a new notification type, `event_feedback`. | VERIFIED |
| Promoter referrals | `promoter_links` (an 8-character code, 0–30 % of the organiser's net; promoters must be outside the organising team). `?ref=CODE` on the event page is remembered for the tab and sent with paid orders. A malformed code is ignored, and servers without migration 28 get the old 4-argument call. On payment, a share moves from organizer_payable to **promoter_payable** in the journal (plus a matching organiser sub-ledger adjustment). Refunds and lost chargebacks reverse it in proportion. Self-referral is not paid and raises a signal. | VERIFIED. **Promoter payouts are not built:** amounts accrue in promoter_payable and the Earnings page says so. |
| Exports | Sales CSV and door-list CSV for managers and admins. Neither contains emails or phone numbers, and every export is audit-logged. CSV cells a spreadsheet would run as formulas are neutralised. | VERIFIED |
| Housekeeping | If pg_cron can be installed, it schedules expire_orders (every 5 min), release_stuck_refunds (every 10 min) and finance_reconcile (daily). If it cannot be installed, the migration still succeeds and nothing is scheduled. | INFERRED for the live project (pg_cron is available on Supabase but not installed; the guarded install has not been run there). |
| Reconciliation fix | Orders paid too late for stock (refund kind `oversold`) no longer raise false "missing sale journal" or "ticket count" cases. Fixed in migration 27, which has not been applied anywhere yet. | VERIFIED |

**Frontend**:
* **Event page:** change notice; reviews (summary, form, organiser replies); complaints (buyer and manager views); "Promoters & exports" card (links with orders and earnings, CSV exports, declare a change).
* **Earnings:** payout-hold notice with appeal, and "As a promoter".
* **Admin → Tickets & Trust:** new **Risk** tab (cases with evidence, appeal and the enforced effect; decisions need a reason; rule tuning) and **Complaints & reviews** tab (escalated complaints; hide or restore reviews).
* Notification texts for complaints and for system-sent event changes.

| Command (this session) | Result |
| --- | --- |
| `npx tsc --noEmit`, `npm run build` | pass |
| `npx vitest run` | **466 passed** (24 files): 12 new migration-28 DB tests, 6 new unit tests (codes, exports, CSV formula guard) |
| `scripts/tickets-concurrency.sh` (PostgreSQL 16, all 28 migrations) | **12/12 pass** |
| `scripts/round10-check.mjs` (browser, mocked backend) | **34/34 pass** |
| `scripts/round9-check.mjs` | all pass (re-run after these changes) |
| update-27 and update-28 applied to copies at migrations 26 and 27 | every check row true; safe to run again |

## E. Deployment status

* Committed and pushed to `claude/share-memory-reel-ux-t1gvap`. **Not merged, not deployed, migrations 27 and 28 not applied, edge functions not redeployed.** Waiting for your go-ahead.
* Order to apply: update-27, then update-28 (SQL editor or the `db-update.yml` workflow), then deploy the edge functions (`deploy-functions.yml`: pay-start and the notification handlers record payment notifications), then the app.
* Effect of applying: same prices as today; **the 3 active events with paid ticket types stop selling paid tickets until an admin approves them** (no sales have ever happened, so no buyer is affected); organisers no longer see ticket codes; payouts need a second admin above R5,000.
* Rollback: re-run the function bodies from migrations 6/8 (listed at the top of migration 27) and `grant select on public.tickets to authenticated`; new tables can stay. Or set `require_sales_review = false` (Admin → Finance) to lift only the sales gate.

## F. Remaining work (prioritised)

1. **Decide commercial terms** (keep buyer fee, or switch to organiser commission) — yours; legal review of buyer-fee disclosure.
2. **Install pg_cron** (or schedule `finance_reconcile()` daily another way): lapsed holds and stuck refunds otherwise wait for a manual run.
3. Provider: confirm PayFast/Ozow mode and credentials; run a sandbox purchase → ITN → ticket → refund end to end.
4. Settlement model: provider-supported split/payout or documented manual EFT process; legal review (custody of organiser funds, CPA/ECTA, POPIA, tax). BLOCKED until then for "live payouts".
5. Done in increment 2: risk engine, reviews, complaints, promoter referrals, exports.
6. Still open: promoter payouts; email notifications (no email provider configured, so in-app only); importing processing fees from provider statements; device fingerprint and IP velocity signals (VYBE does not collect these, which would need a privacy decision); a PayFast/Ozow sandbox round trip once the secrets are in place. All PROPOSED or BLOCKED.
