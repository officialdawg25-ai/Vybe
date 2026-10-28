# VYBE Tickets operations: implementation report (migrations 43–44)

Labels: **VERIFIED** (run or inspected in this session), **PARTIAL**, **INFERRED**, **PROPOSED** (designed, needs a decision or not built), **BLOCKED** (needs someone or something outside this session).

## 1. Baseline (before this work)

| Item | Finding | Status |
| --- | --- | --- |
| Code | `officialdawg25-ai/Vybe` `main` @ `9c8978c`; React 18 + Vite + TypeScript; Supabase (Postgres 17, RLS, Edge Functions); Cloudflare Worker `vybe` built by Workers Builds from `main` | VERIFIED |
| Production database | Supabase `ukgtcungmisthtmknxni`, migrations 1–42 applied; 7 events, 5 ticket types, 5 orders (1 paid), 1 ticket, 0 scans | VERIFIED (read-only) |
| Already present | Checkout with row-locked inventory and holds; PayFast + Ozow with verified, idempotent notifications; tickets issued once per paid order; refunds, chargebacks, payouts, double-entry journal, reconciliation; signed rotating QR; door staff; transactional email queue over SMTP | VERIFIED |
| Added by migration 43 (previous turn, not yet live) | Entry windows, postponement, zones/gates, sessions, re-entry, reserved seats assigned at issuance, ticket references, credential versions, append-only admissions, scanner sessions, one decision function for every scan path | VERIFIED (tests); not deployed |
| Gaps this round addressed | No seat choice at checkout; no zone/session limits; no offline or venue-network mode; no investigation screen; ticket email lacked event time, place and seats, no suppression; no retention policy | VERIFIED |
| Pre-existing defect found | `trg_rsvp_capacity` (migration 1) locks the event row `FOR UPDATE`, which conflicts with every concurrent order's foreign-key lock on that event. Harmless alone; with per-event capacity counting it caused **deadlocks** (found by the concurrency script). Fixed in 44 (`FOR NO KEY UPDATE`). | VERIFIED |

## 2. What changed

| Area | Files |
| --- | --- |
| Database | `supabase/migrations/20261125000043_event_admission.sql` (QR signature now from a per-ticket key, for offline checks), `supabase/migrations/20261126000044_tickets_operations.sql`; packaged as `supabase/manual/update-43/` and `update-44/run-me.sql` (all-or-nothing, re-runnable, 8 check rows each) |
| Offline rules (shared by phone and venue box) | `src/lib/offline.ts`, encrypted phone storage `src/lib/offlineStore.ts` |
| Venue-local gate | `local-gate/gate.mjs`, `local-gate/page.html`, `local-gate/README.md` |
| App | Door screen `src/components/tickets/DoorScanner.tsx`; organiser panel `DoorSetup.tsx`; seat plan `SeatPicker.tsx`; checkout `src/components/EventExtras.tsx`; investigation `src/pages/ScanInvestigation.tsx` (`/app/scans/:event`); admin `src/pages/admin/Privacy.tsx` (`/admin/privacy`); order page email status `src/pages/Orders.tsx`; `src/lib/admission.ts`, `src/lib/tickets.ts` |
| Email worker | `supabase/functions/_shared/handlers/email.ts` (ticket details in the paid-order email) |
| Tests | `tests/db/rls.test.ts` (+29 DB tests for 43/44), `tests/unit/offline.test.ts`, `tests/unit/local-gate.test.ts`, `tests/unit/admission.test.ts`, `tests/unit/email.test.ts`, `scripts/tickets-concurrency.sh` (+9 checks), `scripts/round22-check.mjs`, `scripts/round23-check.mjs` |

## 3. Database (migration 44)

| Object | Purpose | Integrity / access |
| --- | --- | --- |
| `seat_holds` | Seats a buyer picked: held → ordered → sold, or released/expired | One live hold per seat (partial unique index); read by the holder, the event's managers, admins; written only by functions |
| `event_seats.block`, `restricted_view`; `ticket_types.seat_selection` | Seat plan detail; who picks seats | Organiser-writable through existing RLS |
| `event_sessions.capacity` | Day/session limits | Guarded like zones |
| `events.admission_mode`, `offline_authorized_until`, `offline_plan_note` | Door mode | Set only by `set_admission_mode` (managers, plan ≥ 20 chars, end time ≤ 12 h after the event), audited |
| `offline_manifests` | Record of offline data issued to a phone (not the data) | Managers/admins read |
| `ticket_scans` + `mode`, `device_time`, `device_seq`, `manifest_id`, `sync_status` | Online, venue, offline and manual scans in one log | Idempotent per (scanner, request id) |
| `ticket_admissions` + `mode`, `device_time` | Where an admission came from | Append-only (migration 43) |
| `scan_cases`, `scan_case_events` (append-only), `scan_case_actions` | Investigations; two-person actions | Investigators = event managers + VYBE staff; `decided_by <> requested_by` constraint |
| `email_suppressions`, `email_outbox.status` + `bounced` | Bounce/complaint handling | Admin only |
| `retention_policies`, `retention_policy_history` (append-only), `legal_holds`, `retention_runs` | POPIA retention registry | Admin only; writes through functions |
| Functions | `seat_map`, `hold_seats`, `release_my_seat_holds`, `create_seated_order`, `inventory_report`, `set_admission_mode`, `offline_manifest`, `offline_sync`, `scan_search`, `scan_detail`, `case_open`, `case_update`, `case_request_action`, `case_decide_action`, `resend_ticket_email`, `order_email_status`, `admin_email_suppress`, `retention_apply`, `admin_set_retention_policy`, `admin_legal_hold` | All re-check the caller; none callable by anonymous users; trigger and internal helpers not callable over the API |
| Triggers | `order_item_capacity` (zone/session limits + buyer-chosen seats need a hold), `capacity_change` (no reduction below sold, audited), `ticket_seat` (buyer's own seat first), `rsvp_capacity` (lock fix) | |
| Scheduled | `vybe-retention` daily 02:41 UTC (applies approved policies only), `vybe-seat-holds` every 10 min (tidies lapsed holds; correctness never depends on it) | If pg_cron is present |

## 4. Admission model

| Mode | Behaviour | Guarantee | Status |
| --- | --- | --- | --- |
| **Online** (default) | Every scan decided by `admission_scan` on the server; atomic redemption; idempotent | One admission per ticket across all phones (30 concurrent gate scanners → 1) | VERIFIED |
| **Venue network** | Phones scan through `local-gate/gate.mjs` on the venue Wi-Fi; one process decides; ledger fsynced before answering; uploaded afterwards | One admission per ticket across phones paired to that gate (50 concurrent → 1; survives restart). Not across other boxes or online phones until upload. | VERIFIED in tests; **not deployed at a venue** (BLOCKED on hardware, Wi-Fi, TLS certificate and a rehearsal) |
| **Independent offline phones** | A supervisor loads offline data (≤ 12 h, gate-scoped); scanning switches to offline only if someone ticks "Use offline admission"; answers say PROVISIONAL; queue encrypted on the phone and uploaded automatically | **None across phones.** A copy can get in once per phone. Conflicts are cases, never merged silently. | VERIFIED (tests and browser) |

The screen states ONLINE / OFFLINE / OFFLINE (provisional) / SYNC PENDING / SYNC CONFLICT. A failed online check never becomes an offline decision unless the supervisor has switched it on. Answers: ADMIT, ALREADY USED, WRONG EVENT, NOT YET VALID, EVENT ENDED / ENTRY CLOSED, INVALID, CANCELLED / REFUNDED, PAYMENT NOT CONFIRMED, WRONG GATE, HOLD — SUPERVISOR, SYSTEM UNAVAILABLE — DO NOT ADMIT.

**Credentials and keys.** QR = `VYBE3:<ticket>:<version>:<30 s window>:<sig>`, sig = first 80 bits of SHA-256(k, window), k = SHA-256(server secret, ticket, version). The server secret never leaves the database. Offline data carries the per-ticket keys of one event only; transfer, reissue and revoke raise the version, which retires all earlier keys, QRs and codes. **Key rotation of the master secret** (would invalidate every live QR for ~1 minute while apps refetch) and an emergency "revoke all offline data for an event" switch are **PROPOSED**; today a leaked manifest is contained by expiry (≤ 12 h) and by reconciliation.

**Sync.** `offline_sync` takes up to 500 scans per call; each has an id (idempotent), a sequence number (gaps open a case), the phone's time and the manifest. A provisional ADMIT becomes a confirmed admission only if the central ledger has no other entry; otherwise `offline_conflict`. Refunded/revoked/unknown tickets → `sync_rejected`; after a session was revoked → `after_revocation`; phone clock off by > 5 min → `clock_anomaly`. 20 simultaneous uploads of one scan → 1 admission, 1 record (VERIFIED).

## 5. Seating and inventory

- Buyers pick seats on the plan (accessible and restricted-view seats marked); `hold_seats` holds them for 10 min (configurable 2–30) under row locks, all or nothing. The order keeps the seats for its own payment window; the seat follows the order to issuance. 30 buyers grabbing one seat → 1 hold (VERIFIED).
- Late payment for a seat someone else took after the hold lapsed: ticket issued **without** a seat, a high-severity reconciliation case opens, the door holds it for a person; nobody is moved silently (VERIFIED).
- Zone and session limits are shared across every ticket type admitting to them, counted one order at a time per event: 40 buyers, two types, a 9-place zone → exactly 9, the other 31 told it is sold out, **no deadlocks** (VERIFIED; the same test oversells to 10 if the lock is removed).
- Capacity can't be reduced below what is sold or held; every change is audited. Refunded tickets do not go back on sale automatically; a refunded seat becomes free.
- Inventory report: for sale, in checkout, sold, used, refunded, voided, available; zones and sessions taken vs limit; seats sold/held/blocked/free.
- Not built (PROPOSED): accessible-seat companion rules, organiser seat-block holds with a reason, complimentary allocations as a separate pool.

## 6. Email

- Flow: verified payment → tickets issued once → notification → `email_outbox` row → `email-send` worker claims a batch, writes plain text, sends over SMTP (port 465), records sent/failed/skipped; up to 5 attempts.
- The paid-order email now has the event time in its own time zone, doors, venue, order reference and each ticket's reference, category, zones, seat ("General Admission — No reserved seat" when none) and entrance. **No QR or code in email**: the live ticket opens in VYBE after signing in, so a forwarded email cannot get anyone in and is useless after a transfer or refund.
- "Sent" means the provider accepted it; the order page says "handed to our email provider", never "delivered". Bounces/complaints are recorded by an admin (Privacy & retention); queued ticket mail to a suppressed address is skipped. **Automatic bounce intake needs a provider webhook** (PROPOSED).
- Resend (buyer, organiser, staff): same tickets, current address, ≤ 3 per hour, never issues a ticket (VERIFIED).
- Live SMTP delivery: depends on the SMTP secrets noted in `docs/vybe-tickets-report.md` (BLOCKED if not set).

## 7. Investigation

- `/app/scans/:event` (event managers and VYBE staff; not door staff). Filters: time range, ticket reference, order reference, outcome, gate, ticket type, device, validation mode, sync status, case status, repeats/conflicts only. Paged on the server (25 per page), indexed.
- Detail: the scan, the event, the ticket's current state, seat, order and refund state, **every scan of the ticket in order** (server time and phone time), admissions, cases. Offline conflicts are labelled as possibly unorderable. No emails, phone numbers or payment details.
- Cases: open, notes, statuses (under review, evidence requested, escalated, resolved, closed with a reason), append-only history. Two-person actions: record a supervised admission (a new record that never rewrites a scan) and revoke a ticket; the requester cannot approve. There is no "make unused again" button.
- Every search and detail view is written to the audit log.

## 8. POPIA retention — proposal for legal review

Nothing is deleted or anonymised until an admin records an **approval reference** from VYBE's Information Officer and a South African legal adviser. Legal holds (event, ticket, order or person) and open investigation cases always win. Dry runs count without changing anything; every run is logged with the policy versions.

| Category | Purpose | Clock starts | Proposed period | At the end | Enforced by code |
| --- | --- | --- | --- | --- | --- |
| Scan records | Admission control, disputes | Event end (actual, after reschedules) | 12 months | Delete | Yes |
| Admission records (who scanned) | Attendance evidence, reviews | Event end | 12 months | Anonymise scanner links | Yes |
| Scanner device labels | Door security | Event end | 12 months | Anonymise | Yes |
| Offline manifest records | Offline control | Event end | 3 months | Delete | Yes |
| Seat holds (ended) | Checkout | Closed | 30 days | Delete | Yes |
| Email delivery logs (no bodies stored) | Delivery and support | Created | 6 months | Delete | Yes |
| Investigation cases and notes | Disputes, fraud | Closed | 24 months (proposal) | Keep until decided | No (legal decision) |
| Security audit log | Accountability | Created | — | Keep until decided | No |
| Orders, tickets, receipts, invoices | Contract, tax, accounting | Created | — (tax/accounting rules) | Keep | No |
| Payments, refunds, chargebacks, payouts, journal | Financial and provider obligations | Created | — | Keep | No |
| Complaints | Consumer protection, support | Closed | — | Keep | No |
| Risk cases, reconciliation exceptions | Incident management | Closed | — | Keep | No |

Outstanding legal decisions (BLOCKED on your attorney / Information Officer): purpose and lawful basis per category; periods for the "keep" categories (tax, CPA, ECTA, provider contracts, chargeback windows); VYBE's role vs the organiser's (responsible party / operator) for attendee data; processor agreements (Supabase, email provider, Cloudflare) and cross-border transfer; how deletions reach backups (Supabase point-in-time backups keep data for their own window); data-subject request handling; breach response roles. Offline data on phones is limited to ≤ 12 h and encrypted at rest; the venue gate's files must be deleted after upload (README).

## 9. Tests (all run in this session)

| Command | Result |
| --- | --- |
| `npx tsc --noEmit`, `npm run build` | pass |
| `npm test` | **all pass** (see the final count in the PR); new: 29 DB tests (43/44), 8 offline-judging, 6 local-gate, 12 admission, 2 email |
| `scripts/tickets-concurrency.sh` (PostgreSQL 16) | **24/24 checks pass**, incl. zone race (exactly 9 of 9, no deadlocks; mutation without the lock oversells → test fails), 30 buyers / 1 seat → 1 hold, 20× same offline upload → 1 admission |
| `scripts/round23-check.mjs` (browser, mocked backend, 390 px) | **all pass**: seat plan, countdown, seated checkout, offline opt-in and provisional answers, fast second offline answer, sync conflicts shown, investigation paging/filters/detail/approval, privacy admin, email status; axe WCAG A/AA clean on the seat plan, door, investigation and privacy screens |
| `scripts/round9/20/21/22-check.mjs` | pass |
| Update 43 + 44 on a copy at migration 42 with existing data | 8 + 8 check rows true; re-runs safe |
| Performance (local PostgreSQL, previous turn) | ~11 ms per online admission decision, ~1,190 scans/s with 20 scanners. Phone network latency and camera decode not measured (needs real devices). |
| Not tested | Real venue Wi-Fi and phones; PayFast/Ozow sandbox round trip with seats; real SMTP delivery and bounces; device battery loss mid-queue on real hardware (the queue is persisted on every change and covered by unit tests). |

## 10. Security review

Fixed or prevented this round: deadlock between RSVP and order locks (pre-existing); offline answers can never be shown as online (separate PROVISIONAL label, no silent downgrade); a failed check never counts twice (request ids); offline uploads from a revoked phone are flagged; manifests exclude personal data; investigators can't approve their own high-impact actions; door staff can't search scans. Remaining risks: a leaked manifest lets someone forge QRs for that event until it expires (contained by expiry and reconciliation); independent offline mode is duplicate-prone by design; the gate box is as secure as the computer and Wi-Fi it runs on; email suppressions are manual; 26 foreign keys from migrations 28–29 still lack indexes (advisor, pre-existing).

## 11. Deployment

See the PR for the actual outcome. Order: (1) "Apply database update" with `43 44` (refuses to run before 42; all-or-nothing; check rows); (2) merge → Cloudflare Workers Builds deploys the app; (3) "Deploy Edge Functions" (email template). Rollback: app — redeploy the previous commit; database — the new objects can stay; restore `trg_ticket_seat`, `email_worker_claim` and `trg_rsvp_capacity` from 43/30/1 if needed; retention does nothing unless approved.

## 12. Blocked

Venue hardware, Wi-Fi and TLS certificate for the local gate, and a rehearsal; legal approval of the retention schedule and role allocation; SMTP/PayFast secrets if not set; provider webhook for automatic bounces.

## 13. Operational guide (organisers)

1. **Set up** (event page → Entry, gates & seating): entry times; zones with limits; gates and which zones they take; sessions with limits; for each ticket type: zones, sessions, single entry or re-entry, seating (none / reserved; VYBE assigns or buyer chooses); seat plan (sections, rows, seats); door team (scanner or supervisor, gate, access end time).
2. **Choose the door mode** ("If the internet fails at the venue"): online only, venue network (with the local gate), or independent offline phones. Write the plan and the end time.
3. **Before doors**: test valid, used, refunded and wrong-event tickets on each gate; check every phone shows the right event and gate; for venue network, load and save the offline data and start the gate (local-gate README); for offline phones, each supervisor loads offline data shortly before doors.
4. **During**: watch Entry, gates & seating → live numbers (inside vs capacity, by gate, refused scans, active scanners — stop a lost phone's session there); conflicts and repeats appear in Scan investigation.
5. **After**: make sure every phone shows no SYNC PENDING; upload the venue ledger; work open cases in Scan investigation (two people for admissions and revocations); check the inventory report.

## 14. Launch checklist

- [ ] Apply updates 43 and 44 in production and check all rows true.
- [ ] Deploy the app and the Edge Functions; open an event page, the door, the investigation screen and Admin → Privacy & retention in production.
- [ ] PayFast sandbox purchase with chosen seats end to end (needs secrets).
- [ ] SMTP secrets set; a real ticket email received and readable on a phone.
- [ ] Rehearsal at a venue with real phones: camera speed in daylight and darkness, signal loss, offline opt-in, upload, conflict handling; for venue network, the gate computer, Wi-Fi, certificate and a power cut.
- [ ] Legal sign-off on the retention schedule, roles and processor agreements; then approve policies one by one after a dry run.
- [ ] Staff briefing with the runbook above.
