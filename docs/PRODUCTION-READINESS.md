# VYBE production-readiness: audit and delivery report

Branch `ccr-cb54028f-zeeqvz`, based on `main` at `c89c8d7`. Written 2026-10-21.

**Classification: NOT PRODUCTION-READY.** It is READY FOR STAGING VALIDATION for the fixes listed in A. The reasons are under J.

Status labels used below: **VERIFIED** (confirmed from code, schema, live read-only queries or tests), **PARTIAL**, **MISSING**,
**BLOCKED** (needs access, a provider decision or approval) and **PROPOSED** (suggested, not yet shown to be needed).

---

## Environment as found

| Item | Finding |
| --- | --- |
| Repository | `officialdawg25-ai/Vybe`, default branch `main`. There is no `foundation/greenfield` branch locally or on the remote. Work is on the assigned branch. |
| Supabase project | The brief names `gmorrefhypzdplojgnki`. The **repository and the only project this account can reach are `ukgtcungmisthtmknxni`** ("Vybe", eu-west-2, Postgres 17). All findings are against that project, read-only. |
| Live data | 4 profiles, 2 posts, 4 messages, 2 conversations, 0 published chat keys, 0 promo slides, 0 upcoming events, 2 live memories, 1 organisation, 1 staff member. |
| Migration history | Only `core_schema_tables_and_helpers` is recorded in `supabase_migrations`. Migrations 2–13 were applied by hand (their tables, policies and functions are present). Any future `supabase db push` would try to re-run them. They are written to be re-runnable, but the history should be reconciled first (see I). |
| Baseline checks | `tsc` clean, 251/251 tests passing, build OK. |

---

## A. Executive summary

This branch repairs and verifies the following:

1. **Secure messaging was unusable (P0).** Root cause: Postgres rejected the `chat_keys` upsert because of its column grants. It was not a cryptography fault. The client fix needs no database change.
2. **Profile photos now appear everywhere.** A shared identity store swaps replaced avatars at once, in every tab, and heals stale copies from the database.
3. **The Home feed:**
   - Tapping the logo or Home while on Home now refreshes the feed.
   - Home makes one feed request per visit instead of two.
   - Returning to Home is instant, using an in-memory, per-account snapshot that is reconciled with the server.
   - The next page is fetched before the reader reaches it.
   - Gallery images are signed in one batch.
4. **Post creation:**
   - Double taps are guarded.
   - The authoritative post appears on Home immediately, with a "Post shared" confirmation.
   - Closing a composer that was opened directly no longer leaves VYBE.
5. **Memory rail:**
   - Close stays visible while the rail is open, and Escape folds it.
   - Your own story slot no longer treats a failed request as "no memory".
   - Expiry updates live.
6. **The Home billboard no longer disappears** when there is nothing to show. That is the live project's current state.
7. **Discover hero (new).** It has its own placement and truthful labels (Sponsored, From VYBE, Announcement), and admins can configure it.
8. **Migration 14** (written and tested, **not applied**):
   - Fixes a storage policy bug that hid lineup images and community covers.
   - Adds promo placements and labels.
   - Removes signed-out access to visibility helpers (`are_friends`/`is_blocked` could be probed by anyone).
9. **Security headers.** Enforced where they cannot break the app; the CSP ships as Report-Only for staging.

Not done: the campaign/advertiser engine, the organisation campaign workflow, admin user/organisation management, multi-device or group E2EE, and recovery beyond the existing passphrase backup. These are listed under I.

---

## B. Root causes of the reported defects

`scripts/production-check.mjs` drives a real Chromium against a mocked backend. Its mock follows the database rules these fixes rely on.

| Build | Result |
| --- | --- |
| Previous build (`c89c8d7`) | **20 checks fail** |
| This branch | **All 37 pass** |

| # | Report | Status | Root cause and evidence | Fix |
| --- | --- | --- | --- | --- |
| 1 | DMs and group chats fail with a passphrase error | **VERIFIED (1:1)** | `src/lib/chatKeys.ts` published the key with `.upsert()`. PostgREST turns that into `ON CONFLICT DO UPDATE SET user_id = …`, but `chat_keys` grants UPDATE only on `(public_key, updated_at)`. On production, a rolled-back `EXPLAIN` of that exact statement as `authenticated` returns **`42501 permission denied for table chat_keys`**; without `user_id` in `SET` it is allowed. Live `chat_keys` has 0 rows, so nobody ever succeeded. The thread hides the composer until secure chat is on, so every 1:1 chat was blocked. The previous build shows "permission denied for table chat_keys" in the passphrase sheet. The older test mocks accepted upserts, which is why they passed. | `publishKeys()`: write the backup, update your own key row, insert if none, update again on a concurrent insert. The device keeps the private key before the public key goes live. No grant or RLS change. |
| 1b | …group chats | **Not reproduced** | Groups take the "standard" path in `useSecureChat` and never reach the passphrase gate. No failing group path was found in code. A real error message from a group chat is needed to go further. | — |
| 2 | Profile photo shows on the profile but not elsewhere | **VERIFIED** | Every screen reads `avatar_path` through its own query. `saveAvatar` deletes the old file, so feed cards, comments, inbox, chat header, notifications, rail and calls kept a path that could no longer be signed and fell back to initials. Only the header and profile page re-read the profile. Live avatar data is intact: 3 users, objects exist, folders are correct. | `src/lib/identity.ts` plus `Avatar`. A replace updates every avatar now, and other tabs via `BroadcastChannel`. A failed picture asks the database (under RLS) for that member's current path, batched and throttled. Organisation logos opt out. |
| 3 | Slow profile images, posts, memories | **PARTIAL** | Home fetched the feed twice per visit, because every tab depended on the friend list (measured: 2 requests before, 1 after). Gallery images were signed one by one. Each visit to Home started from a spinner. | Fixed those three. Not measured on a real device or network; see F. |
| 4 | Feed doesn't refresh after a hard reload or logo click | **VERIFIED (logo)** | The logo is `<Link to="/app">`. On Home that is a same-location navigation, so nothing re-fetched (previous build: 2 → 2 requests). A hard reload always fetched fresh; no reload defect was found in code. | Logo and Home tab on Home scroll to top and re-check the server (1 → 2 requests). The snapshot is in memory only, so a reload always reads the server. |
| 5 | Story rail layout and close button | **VERIFIED (visibility)** | Close was the last card, so the rail had to be scrolled to the end to find it. The previous build fails "Close is visible". **"Needs a second tap" was not reproduced** in Chromium: folding shrinks the list and the browser clamps the scroll. | Close is pinned to the right edge while open; Escape folds; focus returns; scroll is reset defensively. |
| 6 | Create-post leaves the user on the wrong screen | **VERIFIED (one path)** | A normal post already returned Home on the previous build. Closing a composer opened directly (a link or a reload) called `history.back()` and went to `about:blank`. A synchronous double-tap guard was missing (state-based only), but the previous build did not double-post in the test. | Close goes Home when there is no in-app history; ref guard; the authoritative record is handed to Home; "Post shared". |
| 7 | Blank billboard without slides | **VERIFIED** | `HomeBillboard` returned `null` with no trending plans and no slides. Live: 0 slides, 0 upcoming events, so Home shows no billboard today. | A house card labelled "From VYBE" keeps the section in place. |
| 8 | Discover has no promotional hero | **VERIFIED (MISSING)** | No hero existed, and `promo_slides` had no notion of placement. | `DiscoverHero` plus `placement`/`label` in migration 14; it degrades to the house card until the migration is applied. |
| 9 | Organisation and admin configuration gaps | **PARTIAL** | See section I. | Admin → Promos now edits placement and label. |

Additional defects found and fixed:

- **VERIFIED** `media_select_visible` (live): `l.image_path = name` and `c.cover_path = name` bind `name` to `event_lineup.name` and `communities.name`. Lineup images and community covers were unreadable to everyone except the uploader. Reproduced in the PGlite RLS suite before the fix.
- **VERIFIED** Signed-out callers could run 13 `SECURITY DEFINER` helpers over RPC, including `are_friends(a, b)` and `is_blocked(a, b)` for any two ids. The live check `has_function_privilege('anon', …)` returns true. Migration 14 moves EXECUTE to `authenticated`.
- Overlapping toasts cancelled each other early, and the status region was mounted only with content, so screen readers could miss it. Fixed.

---

## C. Files changed

**Frontend**
- `src/lib/chatKeys.ts`: `publishKeys()` (no upsert, backup first, local key saved first).
- `src/lib/identity.ts` (new), `src/ui/index.tsx` (`Avatar` resolves through the store; toaster), `src/lib/avatar.ts`, `src/auth/AuthProvider.tsx`. `uid` is passed from post, comment, rail, inbox, thread, notification and call avatars; organisation logos use `kind="org"`.
- `src/lib/feedCache.ts` (new), `src/components/Feed.tsx` (snapshot, reconcile, generation guard, prefetch, refresh event), `src/pages/Home.tsx`, `src/Shell.tsx`.
- `src/pages/CreatePost.tsx`.
- `src/components/MemoryRail.tsx`.
- `src/lib/promos.ts`, `src/components/HomeBillboard.tsx`, `src/components/discover/DiscoverHero.tsx` (new), `src/pages/Discover.tsx`, `src/pages/admin/Promos.tsx`.
- `src/styles.css`.

**Configuration**
- `public/_headers` (new), `scripts/check-headers.mjs` (new), `package.json` (`check:headers`).

**Database**
- `supabase/migrations/20261027000014_media_policy_placements.sql` (new); regenerated `supabase/sql-chunks/`; paste-sized copy in `supabase/manual/run-in-order-9/`.

**Tests**
- `tests/unit/chat-keys.test.ts`, `identity.test.ts`, `feed-cache.test.ts` (new); `promos.test.ts`; `tests/db/rls.test.ts` (upsert reproduction, migration 14 suites); `scripts/production-check.mjs` (new browser check).

---

## D. Database changes

Migration 14 is additive and re-runnable. It is **not applied to the live project**; applying it needs your approval.

| Object | Change | Risk |
| --- | --- | --- |
| `storage.objects` policy `media_select_visible` | Every `name` qualified as `objects.name`. | Makes lineup images and community covers readable exactly when the reader can see the row, the same rule as every other branch of the policy. A private community's cover follows `communities` RLS, which lists private communities' name and description. |
| `promo_slides.placement` (`home`/`discover`, default `home`) and `promo_slides.label` (`sponsored`/`house`/`announcement`, default `sponsored`) | New columns, checks, index, column grants. | Existing rows keep their current behaviour. |
| 13 helper functions | `revoke execute … from public, anon`; `grant … to authenticated` (and `service_role` when it exists). | Anon has no table grants and no reachable policy uses them. `get_auth_hero()` stays public. All 13 signatures were checked against production. |

**Rollback**
- Policy: re-run the `media_select_visible` block from migration 12.
- Columns: `alter table public.promo_slides drop column placement, drop column label`.
- Grants: `grant execute on function … to public` for each helper.

**Apply**: run `supabase/manual/run-in-order-9/01-misc.sql` and then `02-misc.sql` in the SQL editor, after a backup. The front end works before and after.

---

## E. Security findings

### Messaging security model (as built, VERIFIED from code)

- **One-to-one chats** are end-to-end encrypted when both people have turned secure chat on.
  - Keys: ECDH P-256 identity keys (WebCrypto). The private key is non-extractable in IndexedDB.
  - Per-conversation key: HKDF bound to the conversation and both user ids.
  - Messages: AES-256-GCM with a random IV and AAD of `conversation|sender`.
  - Attachments use fresh per-file keys inside the encrypted envelope.
  - Security codes, with a pause on key change (TOFU).
  - The server stores public keys, ciphertext and a passphrase-encrypted private-key backup (PBKDF2-SHA-256, 600k iterations → AES-GCM). The server never sees the passphrase. The browser check confirms the backup never contains it.
- **Limits, stated plainly:**
  - This is a static-DH design, **not the Signal protocol**. There is no forward secrecy or post-compromise security: one leaked identity key decrypts all past and future messages in that person's chats.
  - One device per member (a new device restores the same key from the backup).
  - Who talks to whom, when, and message sizes are visible to the server.
  - **Group chats are not end-to-end encrypted** (TLS in transit, server-readable at rest).
  - If the contact has not turned secure chat on, messages go unencrypted and the thread says so.
  - The README describes all of this accurately.
- **PROPOSED:** evaluate a maintained Signal-protocol implementation (for example libsignal's TypeScript bindings; check licence (AGPL), WASM/browser support and multi-device needs) before claiming forward secrecy or encrypting groups. Do not hand-roll a ratchet.

### Passphrase recovery (as built)

- The account password and the chat passphrase are separate.
- Recovery = restore from the encrypted backup with the passphrase.
- A forgotten passphrase means "start over": new keys, old encrypted messages stay unreadable, and the UI says so.
- There is no escrow. VYBE and its admins cannot read messages or reset the passphrase.
- **MISSING** (proposed): a separate random recovery key, an explicit "I stored it" confirmation, passphrase change without new keys (re-wrap the backup), and a device list with revocation. Each is a design change to review first.

### RLS and isolation

- 141 PGlite RLS tests across several identities (users, staff, admin) pass against the migrations and against the SQL chunks.
- They validate policies as written. They are **not** a test against the live project.

### Supabase advisor (read in full)

| Advisor | Findings | Action |
| --- | --- | --- |
| Security | 32 anon-executable `SECURITY DEFINER` functions | Fixed 13 helpers; the other 19 are trigger functions or `get_auth_hero`/`handle_new_user`/`rls_auto_enable`. |
| Security | 97 `authenticated`-executable `SECURITY DEFINER` functions | By design: RPCs check roles inside. |
| Security | 1 mutable `search_path` (`trg_friendship_lock`) | PROPOSED: pin it. |
| Security | Leaked-password protection is off | **Dashboard setting, BLOCKED on you**: Auth → Password security. |
| Security | 6 tables with RLS and no policy | Intended: server-only tables. |
| Performance | 92 `auth_rls_initplan` | PROPOSED: rewrite `auth.uid()` as `(select auth.uid())` in policies. |
| Performance | 44 unindexed foreign keys | PROPOSED: add indexes after checking query plans at real volume. |
| Performance | 6 multiple permissive policies | PROPOSED: consolidate. |

### Members can probe blocks

`is_blocked(a, b)` still answers any authenticated member about any two ids. Every call site passes the caller (or a trigger's `NEW` row) as one argument, so it can be restricted to `auth.uid() in (a, b)`. That changes semantics every visibility policy uses, so it is **PROPOSED** with a dedicated RLS test pass, not shipped.

### Other checks

- **XSS:** no `dangerouslySetInnerHTML`; every user-supplied URL column is constrained to `http(s)://` in Postgres (VERIFIED).
- **Headers:** `public/_headers` enforces nosniff, a referrer policy, `DENY` framing, HSTS, COOP and a Permissions-Policy. The CSP is Report-Only until it is validated on staging.

### POPIA

Not assessed as a legal matter and not claimed. Existing building blocks:
- data export and account deletion RPCs;
- per-field audience controls;
- notification preferences;
- an audit log for staff actions.

Still needed: a documented processing inventory, retention schedule, operator agreements (Supabase, Cloudflare, LiveKit, PayFast/Ozow), and an incident and breach procedure.

---

## F. Performance evidence

All measured against the mocked backend in headless Chromium. None of it is a real-device or real-network measurement.

| Measure | Before (`c89c8d7`) | After |
| --- | --- | --- |
| Feed requests when opening Home | 2 | 1 |
| Feed requests when tapping the logo on Home | 0 | 1 |
| Returning to Home (in-app) | spinner + full fetch | last snapshot rendered at once, background refresh |
| Initial JS, gzip | 131.9 KB | 134.3 KB (+2.4 KB: identity store, feed cache) |
| All JS, gzip | 542.7 KB | 549.9 KB |

**Not measured** (no real backend, device or network was available): LCP/INP/CLS, query latency and plans at volume, Realtime subscription counts under load, throttled-network timing. No latency numbers are claimed.

LiveKit (570 KB raw) is already loaded only when a call or live room starts (VERIFIED in the build output).

---

## G. Test results (commands actually run)

| Command | Result |
| --- | --- |
| `npm run typecheck` | pass |
| `npm test` (unit + PGlite RLS against migrations) | **276/276 pass** (baseline was 251/251) |
| `SQL_SOURCE=chunks npx vitest run tests/db` | 141/141 pass |
| `npm run build` | pass |
| `npm run check:headers` | pass |
| `node scripts/production-check.mjs` vs this branch / vs `c89c8d7` | all pass / 20 fail |
| `ui-smoke` (every route at 375 px and 1280 px, plus axe) | 136/136, the same as the previous build |
| `social-check` | 153 pass on both builds; both crash at the end on a missing local fixture (`/tmp/claude-0/original.jpg`). Pre-existing. |
| `nav-check`, `discover-check` | 23/23 and 35/35 on both builds |
| `billboard-check` | 26/26. Three checks asserted that an empty billboard is hidden; the brief reverses that, so they now assert the house card (and still assert that a `javascript:` slide never renders). The previous build fails those three. |
| `features-check` | 46 pass, 1 fail (cropper drag) on **both** builds. Pre-existing; not investigated. |

Read-only production checks: schema and grants, the `EXPLAIN` reproduction, storage policy text, advisors, function signatures.

**Not run:** tests against a live or staging backend with two real accounts; organisation/admin end-to-end journeys (the campaign workflow does not exist); load tests.

---

## H. Deployment status

**Committed and pushed to `ccr-cb54028f-zeeqvz`.**

- Not merged.
- Not deployed to Cloudflare.
- Migration 14 not applied.
- Nothing was written to the production database: all live access was read-only, and the one `EXPLAIN` ran in a rolled-back transaction.

---

## I. Outstanding work

### Needs your decision or access (BLOCKED)

1. Confirm the Supabase project. The brief says `gmorrefhypzdplojgnki`; the repo and the only accessible project say `ukgtcungmisthtmknxni`.
2. Approve applying migration 14, and reconcile the migration history (record versions 2–14 in `supabase_migrations.schema_migrations`, or keep applying by hand).
3. Turn on leaked-password protection, and consider CAPTCHA and MFA for staff accounts (Auth dashboard).
4. Payment and billing for advertising: provider choice and contracts. Never accept money for placements before this exists.
5. Choose an E2EE protocol for groups and multi-device (and accept its licence).

### MISSING (the brief asks for them; not built here)

- **Campaign engine:** campaign entity, state machine (Draft → Submitted → Under review → Approved → Scheduled → Live → Paused/Completed/Rejected) enforced by server RPCs, an organisation-owned campaign and creative submission flow, frequency caps, budgets, deduplicated viewable-impression events, reports.
  - Today: admin-managed `promo_slides` with draft/live/paused, schedule, city targeting, and once-per-member-per-day impression and click counts. That covers house and directly sold placements, not self-serve advertising.
- **Organisation workspace:**
  - Exists: events, members (invite/accept), settings, posts, check-in, finance and refunds.
  - Missing: campaign submission and tracking, roles beyond owner/admin/editor (campaign manager, analyst), ownership transfer, an audit history view.
- **Admin:**
  - Exists: moderation (reports, audited content removal), brand hero, Discover categories, music, verification plans, promos, finance.
  - Missing: user and organisation account management (suspension is not implemented), support cases, announcements, an audit-log viewer, feature flags, retention jobs, a service-health view, re-authentication for high-risk actions.
- **Posts:** idempotency across uncertain networks. The ref guard stops double taps, but a lost response followed by a retry can still duplicate. Proposed: a `client_id` column with a unique index, like `messages`.
- **Media:** no server-side image variants (thumbnails/WebP/AVIF). Supabase image transformations depend on the plan and were not assumed. Avatars and covers are cropped client-side; posts upload originals.

### PROPOSED

- RLS `initplan` rewrite; foreign-key indexes after query-plan review.
- `is_blocked`/`are_friends` caller restriction.
- Pin `search_path` on `trg_friendship_lock`.
- Enforce the CSP after a staging soak.
- Scroll restoration for other routes.

---

## J. Readiness classification

**NOT PRODUCTION-READY.**

- The reported P0 (messaging) and the UI defects are fixed and verified in a browser against a mock that mirrors the database's rules.
- But the production-readiness gates in the brief are not met:
  - the commercial chain (campaign → approval → placement → measurement → billing) does not exist;
  - organisation and admin operations are incomplete;
  - group messaging is not end-to-end encrypted, and there is no forward secrecy;
  - nothing has been tested against a live or staging backend with real accounts;
  - no real-device performance measurements exist.

**READY FOR STAGING VALIDATION** for this branch's fixes:
1. Deploy the branch to a staging Worker.
2. Apply migration 14 to a staging copy.
3. Run the two-account journeys in section 16.2 of the brief: secure chat both ways, avatar change seen by the other account, post → Home, rail, billboard, Discover hero.
