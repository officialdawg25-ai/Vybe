# VYBE event admission: implementation report (migration 43)

Status labels: **VERIFIED** (run and inspected in this session), **PARTIAL**, **INFERRED**, **PROPOSED** (not built), **BLOCKED** (needs someone outside this session).

## 1. Baseline before this work (inspected 2026-10-28)

| Item | Finding | Status |
| --- | --- | --- |
| Repository / branch | `officialdawg25-ai/Vybe`, `main` @ `9c8978c`; work on `ccr-388778eb-oaft6t`. The historical `foundation/greenfield-v1` branch and `vybeaccess.pages.dev` URL in the brief are **not** what production uses today: production is the Cloudflare Worker `vybe` (`vybe.officialdawg25.workers.dev`), built from `main` by Workers Builds. | VERIFIED |
| Stack | React 18 + Vite + TypeScript; Supabase (Postgres 17, RLS, Edge Functions); Cloudflare Worker with static assets | VERIFIED |
| Production database | Supabase project `ukgtcungmisthtmknxni`, migrations 1–42 applied (checked read-only). 7 events (4 active, 3 draft), 5 ticket types (3 general, 1 VIP, 1 VVIP), 5 orders (1 paid), **1 ticket (valid, never scanned), 0 scans**, 1 door-staff row, rotating QR not yet required | VERIFIED (read-only queries) |
| Payments | PayFast + Ozow already integrated: signed/verified notifications recorded once per (provider, transaction, status), amount/merchant checks, idempotent settlement, tickets issued once per paid order, oversold-hold refunds, double-entry journal, reconciliation, refunds, chargebacks, payouts with maker-checker (migrations 6, 8, 28–30) | VERIFIED (code + existing tests) |
| Ticketing already present | Ticket types with tiers (general / early bird / VIP / VVIP / backstage / student / table / group), row-locked inventory and holds, organiser sales review before paid sales, event-bound atomic redemption (`admit_ticket`), door staff per event, a log of every scan, throttling of bad codes, holder-only static codes, signed 30-second rotating QR (`VYBE2`) | VERIFIED |
| Gaps found | No entry window (a ticket admitted days before the event); no postponed status; no zones, gates or gate-restricted staff; no seats; no sessions or re-entry; no scanner sessions or device revocation; no idempotency on scans; **a transferred ticket's old static code and cached QR tokens still worked for the previous owner**; `wrong_event` did not say which event the ticket was for; ticket references not human-readable; issued inventory not bounded by event capacity | VERIFIED |

## 2. What was built

### Database — `supabase/migrations/20261125000043_event_admission.sql` (packaged as `supabase/manual/update-43/run-me.sql`)

| Area | What now exists | Status |
| --- | --- | --- |
| Event schedule | Status `postponed` (alongside draft / active / cancelled / completed); `doors_open_at`, `entry_closes_at`; platform defaults (doors 6 h before start, entry until the end or 12 h after the start); door times move with the event when it is rescheduled; append-only `event_schedule_changes`; holders notified on postpone / resume | VERIFIED |
| Sessions | `event_sessions` + `ticket_type_sessions`: day passes, afternoon/evening, weekend passes; single use **per session** | VERIFIED |
| Zones and gates | `event_zones` (general, standing, seated, vip, vvip, lounge, backstage, accessible, table, other), `event_gates` (open/closed, "takes general admission" flag), `gate_zones`, `ticket_type_zones`. Links across two events are refused by trigger. VIP/VVIP are only what the organiser ticks, never inferred from name, colour or price | VERIFIED |
| Seats | `event_seats` (unique per event/section/row/seat), `tickets.seat_id` with a unique index on live tickets; reserved-seat types are seated automatically at issuance under row locks; seat moves audited (`ticket_seat_changes`, append-only); a sold seat cannot be blocked or renamed | VERIFIED (incl. 40 concurrent issuances for 25 seats) |
| Ticket entitlements | Per type: entry window override, entry policy (single / re-entry with max entries), seating (none / reserved) | VERIFIED |
| Ticket identity | `tickets.ref` (`VT-XXXX-XXXX`, look-alike-free, unique, for people — not a credential); `qr_version` credential version | VERIFIED |
| QR credential | `VYBE3:<ticket>:<version>:<30 s window>:<80-bit keyed signature>` (server-only secret). Transfer, reissue and revoke raise the version **and** replace the static code, so every earlier screenshot, token and code stops working. `VYBE2` tokens still accepted only at version 0 (no break for current holders) | VERIFIED |
| Admissions | `ticket_admissions` (append-only, entries and exits, override flag); unique index = one successful single-use entry per ticket (per session) on any path | VERIFIED |
| Door team | `event_staff.role` scanner/supervisor, optional `gate_id`, optional `expires_at`; `scan_sessions` per device, revocable by the organiser | VERIFIED |
| Decision | `admission_core` (server-only) in the brief's order: signed in → session/role/gate → credential → ticket → **exact event** → event status → ticket status → payment → session → entry window → gate/zone → capacity → prior use / re-entry → seat / manual-review holds → redeem atomically. Idempotent per (scanner, request id), including two copies of one request racing. Every attempt logged with decision and response | VERIFIED |
| Door API | `start_scan_session`, `admission_scan`, `admission_override` (supervisor, reason ≥ 5 chars, audited, only lifts manual-review holds), `end_scan_session`, `revoke_scan_session`. `admit_ticket` / `check_in_ticket` now run through the same core (gate-restricted staff are refused there) | VERIFIED |
| Organiser | `generate_seats`, `assign_seat`, `revoke_ticket`, `reissue_ticket` (also for holders; max 3/day), `admission_dashboard` (issued, admitted, inside now vs capacity, unseated, by decision, by gate, by type, active scanners, tickets refused 3+ times) | VERIFIED |
| Holder | `my_ticket_details` (ref, seat or "General Admission — No reserved seat", zones, entrances, window, sessions used), `my_ticket_conflicts` (overlapping tickets — help only, never affects admission) | VERIFIED |
| Capacity | Ticket inventory may not exceed `events.capacity`; at the door a full venue holds entry for a supervisor (not overridable) | VERIFIED |
| RLS / grants | New tables: read for people who can see the event, write for its managers; admissions, scan sessions, schedule history and seat changes readable by managers/admins only; nothing writable directly that decides admission; trigger functions not callable over the API; every new foreign key indexed | VERIFIED (advisor rules from migration 21 re-run) |

### Decision codes (what the door shows)

`ACCEPTED` (ADMIT) · `EXITED` · `WRONG_EVENT` ("valid for *X*, not *Y*"; the other event's name only if it is public) · `NOT_YET_VALID` (with opening time) · `EXPIRED` · `ALREADY_USED` (first time and gate) · `INVALID` · `REVOKED` (cancelled/refunded/revoked) · `WRONG_GATE_OR_ZONE` · `WRONG_SESSION` · `PAYMENT_NOT_CONFIRMED` · `EVENT_CANCELLED` · `EVENT_POSTPONED` · `MANUAL_REVIEW` (hold) · `QR_EXPIRED` · `STATIC_CODE` · `FORBIDDEN` · `RATE_LIMITED`, plus the client-only `NOT_VERIFIED — DO NOT ADMIT` when the server did not answer.

### App

| Screen | What changed | Status |
| --- | --- | --- |
| Door (`/app/scan/:event`, also in the organisation portal) | Pick gate (and session) → scanner session; event, date, venue, gate and role always on screen; online/offline badge; camera with flashlight where supported; typed code, or reference lookup for supervisors; big ADMIT / DENY / HOLD with icon + word + tone (colour is never the only signal); supervisor override with reason; entry/exit mode for re-entry; session history with filter; camera permission troubleshooting; end session. **Fail-closed**: a scan with no server answer shows NOT VERIFIED and is retried with the same request id | VERIFIED (browser, mocked backend) |
| Event page, organiser | "Entry, gates & seating": live numbers; entry times; postpone / set new date; zones; gates (zones, general admission, open/closed); sessions; what each ticket type admits to (zones, sessions, entry policy, seating); seat generator; door team with role, gate and expiry; stop a scanner session; warnings for impossible setups | VERIFIED (browser, mocked backend) |
| Event page, attendee | Postponed notice; "you have another ticketed event at the same time — both tickets stay valid" | VERIFIED |
| My tickets | Reference, seat, access zones, entrance, entry window or sessions, entry policy; QR still shown for re-entry / later sessions; "Get a new QR" | VERIFIED |

## 3. Test evidence (all run in this session)

| Command | Result |
| --- | --- |
| `npx tsc --noEmit`, `npm run build` | pass |
| `npm test` | **621 passed** (33 files). New: 17 database scenario tests for migration 43 + its packaged update; 11 unit tests (`tests/unit/admission.test.ts`). Existing admission tests updated only where the new rules intentionally changed behaviour (doors must be open; `VYBE3` token format) |
| Mutation check | Disabling the exact-event check in the migration makes scenarios B and N fail (the tests detect it) |
| `scripts/tickets-concurrency.sh` (real PostgreSQL 16, all 43 migrations) | **20/20 pass**, three consecutive runs: 30 gate scanners, one QR, same moment → 1 ACCEPTED, 29 ALREADY_USED, 1 admission row; 40 seated tickets issued at once for 25 seats → 40 issued, 25 seated on 25 distinct seats; all earlier checks (oversell, idempotent checkout and webhook, payouts, refunds, reconciliation) still pass |
| Bug found and fixed by that script | Concurrent seat issuance could pick a seat freed by a just-committed transaction from a stale snapshot; the unique index stopped double-booking but aborted the issuance. The seat trigger now re-checks with a fresh snapshot |
| Update on a copy at migration 42 (with a used and a valid ticket) | all 8 check rows true; second run safe; used ticket backfilled as entered; references assigned |
| `scripts/round22-check.mjs` (browser, mocked backend, 390 px) | **35/35 pass**, incl. axe WCAG A/AA on the door screen and organiser panel, no horizontal scroll, NOT VERIFIED offline with one request id over 3 retries |
| `scripts/round9/20/21-check.mjs` | pass (round9 updated for the moved door team and new scanner start) |

### Brief scenarios

| | Scenario | Evidence | Status |
| --- | --- | --- | --- |
| A | Correct event | ACCEPTED, category and seat shown, one admission row | VERIFIED |
| B | UJ ticket at TUT, same time | WRONG_EVENT, no redemption, no attendee data | VERIFIED |
| C | Identical names, time and venue | decided by event id | VERIFIED |
| D | Early / late | NOT_YET_VALID with time / EXPIRED | VERIFIED |
| E | Postponed then new date | EVENT_POSTPONED; old date refused; new date admits; history kept | VERIFIED |
| F | Already used | ALREADY_USED with time and gate; retried request answers the same, counted once | VERIFIED |
| G | Simultaneous scans | 30 concurrent gate scanners → exactly one admission (real PostgreSQL) | VERIFIED |
| H | GA at VVIP entrance | WRONG_GATE_OR_ZONE; VVIP admitted there; scanners held to their gate | VERIFIED |
| I | Reserved seat | "Section A · Row B · Seat 001"; cannot be shared by allocation, direct update or blocking | VERIFIED |
| J | Cancelled / refunded / revoked | REVOKED (revoked also retires the QR → INVALID) | VERIFIED |
| K | Forged QR | altered id/window/version/signature or JSON → INVALID; transfer and reissue retire old credentials | VERIFIED |
| L | Unpaid | PAYMENT_NOT_CONFIRMED; issuance only from verified payment (existing tests) | VERIFIED |
| M | Duplicate webhook | one ticket set, one journal (existing concurrency test, still passing) | VERIFIED |
| N | Unauthorised scanner | other event refused; foreign session FORBIDDEN; revoked session and expired pass stop at once | VERIFIED |
| O | Offline scanner | fail-closed NOT VERIFIED, same request id on retry; **no offline admission mode** (see 6) | PARTIAL (by design) |
| P | Concurrent inventory | 40 buyers / 5 tickets → 5 (existing); 40 seats / 25 → 25 distinct | VERIFIED |
| Q | Access control | decision core, admissions, ticket updates unreachable for customers; others' details null | VERIFIED |
| R | Capacity | inventory above capacity refused; full venue holds entry | VERIFIED |

## 4. Performance (measured, local)

Real PostgreSQL 16 on this container (no network latency, fsync off), 1,000 tickets, 20 concurrent gate scanners with their own sessions, 2,000 scans: **11.1 ms average per `admission_scan`**, about **1,190 scans/s**, 860 tickets admitted = 860 admission rows (no duplicates). Production adds the network round trip between the phone and Supabase; that was **not** measured (needs a real device at a venue). QR decode speed on devices was not measured.

## 5. Security and privacy review

* The scanner sends only a credential, a request id and its own session; event, gate, category, seat and status are read from the database. VERIFIED.
* Door staff never read codes, orders or money. On ACCEPTED they see the holder's display name (for ID checks); denials show no attendee data. WRONG_EVENT names the other event only when it is public. VERIFIED.
* Admission history is append-only even for organisers and the database owner (only references to deleted profiles/gates may become empty). VERIFIED.
* Overrides need a supervisor, a reason and are audited; they cannot admit revoked, unpaid, used, wrong-event or over-capacity tickets. VERIFIED.
* Repeated failed scans: existing per-scanner throttle (40 bad scans / 5 min) and risk rule `invalid_scans`; the dashboard lists tickets refused 3+ times and says to check before assuming fraud. VERIFIED.
* POPIA: no new personal data is collected. Scan logs and admissions hold ids, times, gate and device label (e.g. "Android · Chrome", no fingerprint or IP). **Retention periods for scan logs are not set** — PROPOSED (decide a period, e.g. 12 months after the event, with your legal adviser). Responsibilities between VYBE, organisers and venues still need the contractual review listed in `docs/settlement-and-legal-review.md` — BLOCKED on your attorney.
* Pre-existing, not changed here: 26 foreign keys from migrations 28–29 have no index (advisor rule); `scripts/round11-check.mjs` fails on `main` too; `supabase/sql-chunks/` stopped being regenerated after migration 14.

## 6. Not built (PROPOSED) and limits

* **Offline admission mode** (signed event manifest on the device). Not built on purpose: with several independent phones offline, nobody can guarantee a ticket is not admitted twice. Today the door fails closed. For a venue with known bad signal, the options are a local Wi-Fi/hotspot for the door phones, or a designed offline manifest per gate with documented residual risk.
* Choosing a seat at checkout with a timed seat hold (today seats are assigned automatically at issuance, or moved by the organiser).
* Zone capacity limits (only event capacity is enforced); per-category scanner permissions beyond gates.
* Email copies of tickets (the wallet is the authoritative ticket; the email outbox exists for notices).
* Admin UI for scan investigation (admins can already read scans and admissions through RLS); resale.
* Real-device QR decode and network latency measurements; a staged end-to-end purchase with PayFast sandbox (still BLOCKED on the PayFast secrets noted in `docs/vybe-tickets-report.md`).

## 7. Deployment and rollback

1. **Database first**: GitHub → Actions → "Apply database update" → `43` (or paste `supabase/manual/update-43/run-me.sql` into the SQL editor). It refuses to run before migration 42, runs all-or-nothing, and ends with 8 checks that must all be true. Safe to re-run. It is additive; it backfills ticket references and marks already-used tickets as entered (production has 1 valid ticket and 0 used).
2. **Then the app**: merge to `main`; Cloudflare Workers Builds deploys. The new app needs migration 43 for the door screen; the old app keeps working on the new database (`admit_ticket` and `my_ticket_qr` stay compatible).
3. **Behaviour change on deploy**: tickets are refused outside the entry window (default: from 6 h before the start until the end, or 12 h after the start). Organisers can set their own times.
4. **Rollback**: app — redeploy the previous commit. Database — the new tables/columns can stay (nothing old depends on them); to restore the old door behaviour, re-create `admit_ticket`, `check_in_ticket` and `my_ticket_qr` from migration 37 and `transfer_ticket` from migration 6. Tokens issued as `VYBE3` would then stop scanning until holders reopen their tickets.

## 8. Production readiness (evidence-based)

Ready for staged rollout of admission: the rules, atomicity, idempotency, concurrency and access control are tested against a real PostgreSQL. Before a large event: apply update 43, run a rehearsal with real phones at the venue (camera decode, signal, latency), decide scan-log retention, and decide whether the venue needs a local network for the door. Not claimed: any certification, legal compliance, or a production deployment of this change (not deployed at the time of writing).
