# VYBE production-readiness audit

Branch `ccr-4ba6d335-b6gien`. Date: 2026-10-21. Evidence comes from the code, read-only queries against the connected Supabase
project (`ukgtcungmisthtmknxni`), and the automated checks listed at the end. Browser checks run against a **mocked**
backend. They prove what the UI does and what it sends, not how the live database or LiveKit behave.

Labels: **VERIFIED** (confirmed in code, schema, live query or tests) · **PARTIAL** (some of it exists) · **MISSING** ·
**BLOCKED** (needs access, a provider decision or approval) · **PROPOSED** (suggested, not yet shown to be needed).

## 0. Project identity discrepancy (BLOCKED, needs your answer)

The brief names Supabase project `gmorrefhypzdplojgnki` and branch `foundation/greenfield`. This repository, its built-in
defaults (`src/lib/supabase.ts`) and the connected Supabase account all point at **`ukgtcungmisthtmknxni`**, and the work
happens on `ccr-4ba6d335-b6gien` with PRs into `main`. Nothing was done to `gmorrefhypzdplojgnki`. If that project is the
real production database, say so before any migration is applied anywhere.

## 1. Reported defects: root causes and fixes in this change

| # | Defect | Status | Root cause (evidence) | Fix |
|---|---|---|---|---|
| 1 | "new row for relation posts violates check constraint posts_check" when posting only a song | VERIFIED → fixed | Live query: `posts_check = CHECK (body <> '' OR media_path IS NOT NULL)` (core schema). A song-, feeling- or place-only post has neither. | Migration 15 replaces it with `posts_has_content` (caption, media, song, feeling or place). The client also refuses a post that only has tagged people. DB test + browser test. |
| 2 | Duplicate controls and "Photos up to 25 MB…" wording on New post | VERIFIED → fixed | `CreatePost.tsx` rendered Music/People/Location/Feeling as chips **and** again in the bottom bar. | The bar now holds only gallery, camera and video. The size wording is gone, but limits are still enforced with clear errors. Browser test. |
| 3 | Caption shows old handle ("banks") while header shows "Chief DAWG" | VERIFIED → fixed | `PostCard.tsx` caption used `profiles.username`; the header used `display_name`. | The caption uses the display name. New `lib/liveProfiles.ts` overlays your freshest name/photo on every post, comment and tag you appear in, so a change shows at once without a refetch. Other people's changes show on the next fetch (no realtime on `profiles`, see §3). |
| 4 | Names changeable any time | fixed | No rule existed. | Migration 15: `profiles.display_name_changed_at` + trigger. A name can change once every 14 days after onboarding, and the database enforces it. Clients cannot write the timestamp. Settings and Edit profile lock the field and show the date. DB + browser tests. |
| 5 | Two tabs, two accounts: signing in/out in one tab affects the other | VERIFIED → fixed | Both tabs used the same storage slot (`lib/slot.ts`). Supabase syncs sessions across tabs that share a storage key, so a sign-in replaced the shared session and a sign-out removed it. | Each tab publishes a heartbeat. Sign-out moves **only this tab** to a fresh slot when another open tab shares its slot, so the other stays signed in. The sign-in page does the same, so signing in here never signs another tab in. Sign-out is `scope: 'local'`, so other devices are unaffected. Browser test with two tabs. |
| 6 | "permission denied for table chat_keys" when turning on secure chat | VERIFIED (not a crypto bug) | Migration 14 (applied live) revoked direct writes to `chat_keys` in favour of the audited `publish_chat_key` RPC. The **deployed** site is still the older client that writes the table directly. | Merge and deploy this branch, which already uses the RPC. **Waiting on your authorisation.** |
| 7 | Black block on slide 2/2 of a carousel | VERIFIED → fixed | Carousel slides had a `#000` background, and a paused video with `preload=metadata` paints nothing until it plays. | Slides use the neutral surface colour, and video sources use `#t=0.1` so the first frame shows. |
| 8 | Memory-rail stack showing clipped text ("…mory · 2") | VERIFIED → fixed | Labels of the cards behind the front card peeked out at the stack's edge (screenshot). | In the folded stack, only the front card is labelled. Cards behind show colour only. |
| 9 | Rail layout: shortcuts should stack on the left with people's memories to the right; tapping the stack should fan it out to the right | fixed | Everything (shortcuts and people) was one stack with a "+N" counter. | The four shortcuts (Share/Your memory, Music, Plans, Tickets) fold into a stack on the left. Everyone's visible memories sit to its right, always visible and swipeable. One tap fans the shortcuts to the right, and one tap on Close folds them back to exactly the same place. Loading shows skeletons, and an empty list shows a short note (no fake people). Browser-tested geometry. |

## 2. Brief sections: what exists versus what is asked

| Area | Status | Notes |
|---|---|---|
| Canonical avatar (`profiles.avatar_path`, private bucket, signed URLs with retry and refresh in `useSignedState`) | PARTIAL | One field and one `Avatar` component are used across feed, comments, chat, rail, notifications and search. Own changes now propagate instantly (liveProfiles). **Missing:** realtime propagation of *other* users' changes, and image variants/thumbnails (Supabase image transforms depend on the plan, not checked). |
| Feed pagination, prefetch, caching | VERIFIED (mocked browser tests) | Cursor pages of 15. The next page loads about two screens before the end (data-saver users keep the button). Coming back to Home shows the last result from memory at once, then the server copy replaces it (memory only, per account and tab, so a reload never replays stale posts). A failed refresh keeps what was shown and says it may be out of date. The VYBE logo on Home refreshes in place. Duplicate start-up requests removed (profile ×2, feed ×2). See §4a for measurements. |
| Story rail (stack on the left, expand right, close once, story-vs-profile slot) | VERIFIED (mocked browser tests) | Expand/close, ordering, reduced motion and no overflow are covered by `social-check`. |
| Post creation → Home with "Post shared" | VERIFIED → improved | Returns to Home with the confirmation "Post shared", and the new post arrives with the refresh. The Post button is disabled while posting, and failures keep the draft. **Missing:** idempotency key for uncertain network outcomes (PROPOSED). |
| Home billboard with empty fallback | VERIFIED (`billboard-check`) | Previously an empty or failed billboard disappeared. Now VYBE's own house slide ("From VYBE") holds the place, and is never counted as an ad impression. Impressions count only while at least half the slide is on screen, once per member per slide per day (`promo_track`). |
| Discover promotional hero | VERIFIED (`billboard-check`, migration 16) | New: Discover-only slides above the Discover sections, with its own house fallback. It loads alongside the page (same-size placeholder, so no layout shift). Not shown in search results. |
| Labels: sponsored vs house vs announcement | VERIFIED | Each slide has a kind. Paid ones always read "Sponsored · advertiser"; VYBE's own read "From VYBE" or "VYBE announcement". Organisation campaigns are always sponsored and always carry the organisation's own name, which the database enforces. |
| Campaign workflow (draft → submitted → approved/live, or rejected with reason; live ⇄ paused; scheduled = approved before its start) | VERIFIED (DB tests + `campaigns-check`) | Migration 16. Only VYBE admins can approve, publish, pause or reject, enforced by RLS and a trigger, not the UI. A rejection needs a reason. Organisations can edit or delete only before approval and cannot change priority, label, advertiser name or another organisation's media. Every state change is written to `audit_log`; owners/admins are notified of decisions. |
| Campaign billing | MISSING (stated in the UI) | PayFast exists for tickets and badges only. Campaigns do not take money, and nothing claims they do. Before charging: price list, invoice records, a PayFast flow per campaign, and refunds on rejection. |
| Organisation workspace | PARTIAL → improved | New Campaigns tab for owners/admins: draft, live preview, upload (file type checked by its bytes), submit, see VYBE's reason, fix and resubmit, real delivery counts. Existing: events, page posts, check-in, finance, members, settings. **Missing:** ownership transfer, an organisation audit view. |
| Admin workspace | PARTIAL → improved | "Promotions" (was "Home billboard") now has a review queue (approve, or reject with a reason), placement and label choices, and who submitted each slide. **Missing:** feature flags, retention workflows, admin re-authentication for risky actions. |
| Messaging security model | VERIFIED (unit + DB tests) | True E2EE for opted-in 1:1 and group chats: ECDH P-256 identity keys (non-extractable, in IndexedDB), HKDF, AES-GCM bound to conversation/sender/epoch, per-epoch group keys sealed per member, security codes, key-change warnings, encrypted attachments, LiveKit E2EE calls. Uses WebCrypto primitives; it is **not** the Signal protocol (no forward secrecy per message / double ratchet). Plain chats remain transport-encrypted, server-readable. |
| Recovery | VERIFIED (tests) | Passphrase backup (PBKDF2 600k), recovery key, and **opt-in** VYBE-assisted recovery: 72 h wait, password re-check, cancellable, audited. The escrow is off by default and needs `CHAT_ESCROW_SECRET`. While it is on, VYBE operators could recover that user's key, and the UI says so. An account password reset alone never restores encrypted history. |
| Security headers / CSP | VERIFIED (`csp-check`) | `public/_headers`: CSP with hashed inline script, frame-ancestors none, HSTS, nosniff, Permissions-Policy. |
| RLS | VERIFIED (145 DB tests on PGlite) | Tests run against the migrations, not the live database. |
| Profile column exposure | VERIFIED → fixed (migration 17) | Confirmed live: every column was readable by any signed-in member. Coordinates, notification settings, onboarding answers, country and the onboarding/name timestamps are now readable only by their owner (`my_profile()`). The app's own reads were switched first; older servers fall back. DB test proves other members are refused. |
| Rate limits | PARTIAL | Post/comment/message throttles exist in SQL (`capacity-throttles`). Recovery is rate-limited. Supabase Auth limits are dashboard settings, not checked. |
| POPIA | PARTIAL | Data export, account deletion, privacy page, audience controls exist. No documented assessment, operator agreements or breach procedure, so **no compliance claim is made**. |

## 3. Database changes

Run these in the Supabase SQL editor, in order. Each folder is safe to run twice; the tests apply them on top of migrations
1–14 and also run them twice.

1. `supabase/manual/run-in-order-10/01-posts-and-name-limit.sql` (migration 15)
2. `supabase/manual/run-in-order-11/01-campaigns.sql` (migration 16)
3. `supabase/manual/run-in-order-11/02-profile-privacy.sql` (migration 17). Run it **only together with deploying this
   branch**: the currently deployed site still reads your own profile with `select *`, which 17 refuses.

### Migration 16: campaigns
* `promo_slides`: `placements text[]` (home/discover), `kind` (sponsored/house/announcement), `organization_id`,
  `review_note`, `submitted_at`, `reviewed_by`, `reviewed_at`. The status check adds `submitted`/`rejected`, and the media
  path may be under `promo/o-<org>/`.
* RLS: organisation owners/admins may read, insert and edit their own rows before approval. Admins keep full control.
  Trigger `promo_guard` enforces the state machine and the organisation's name/label. Trigger `promo_audit` writes
  `audit_log` and notifies (new notification type `campaign`).
* Storage: organisation managers may upload or delete only under `brand/promo/o-<their org>/`.
* Rollback: drop the two triggers, functions `promo_guard`, `promo_audit`, `can_manage_campaigns` and policy
  `brand_org_delete`. Restore the earlier policies/checks from migration 9, then drop the added columns.

### Migration 17: profile privacy
* `revoke select on profiles`, then column grants for the public columns. New `my_profile()` (security definer, own row only).
* Rollback: `grant select on public.profiles to authenticated;`

### Migration 15: posts and names

`supabase/migrations/20261028000015_posts_names.sql` (manual copy:
`supabase/manual/run-in-order-10/01-posts-and-name-limit.sql`). Non-destructive: no rows are rewritten.

* `posts`: drop `posts_check`, add `posts_has_content`.
* `profiles`: add `display_name_changed_at timestamptz` (not client-writable), function `limit_display_name_change()`
  (security definer, `search_path = public`, execute revoked from clients), trigger `trg_limit_display_name`.
* Rollback: `alter table public.posts drop constraint posts_has_content, add constraint posts_check check (body <> '' or
  media_path is not null);` (fails if song-only posts exist, so delete or edit them first), then
  `drop trigger trg_limit_display_name on public.profiles; drop function public.limit_display_name_change();
  alter table public.profiles drop column display_name_changed_at;`.

## 4a. Performance (lab measurement, not field data)

`node scripts/perf-check.mjs`: a production build served locally against the mocked backend. Settings: 390×844 phone,
CPU slowed 4×, network about 1.6 Mbps with 150 ms latency, median of 5–7 cold loads. Same machine and script for both
builds. It measures our code only, not Supabase or Cloudflare response times. Differences under about 150 ms are noise.

| Route | Before (b21810f) | After (this branch) |
|---|---|---|
| Home `/app` | FCP 3.3 s · LCP 4.0 s · **CLS 0.246** · 2 duplicate requests | FCP 3.0–3.2 s · LCP 3.3–3.6 s · **CLS 0.028** · 0 duplicates |
| Discover | FCP 2.8 s · LCP 3.0 s · CLS 0.028 | FCP 3.0 s · LCP 3.2 s · CLS 0.028 (now also loads the hero) |
| Messages | FCP 2.9 s · LCP 3.1 s · CLS 0.028 | FCP 2.8 s · LCP 2.9 s · CLS 0.028 |

About 500 KB of JavaScript (uncompressed) is downloaded per route, most of it React/UI and the Supabase client. LiveKit
(570 KB) only loads for calls. Not measured: INP (no real interaction script), real devices, the live database.
PROPOSED next: split the shared `ui` bundle (232 KB) and use responsive image sizes. Supabase image transformations
depend on the paid plan, which was not checked.

## 4. Checks run

All commands were run locally in this session against a production build pointed at a mocked Supabase:

* `npx tsc --noEmit -p .`: pass
* `npx vitest run`: 12 files, 279 tests pass (unit + 152 DB)
* `SQL_SOURCE=chunks npx vitest run tests/db`: 152 pass (the pasteable SQL pieces). The manual folders were also applied on top of migrations 1–14, once and twice: 152 pass.
* `node scripts/social-check.mjs`: all pass, run 3 times (includes the new two-tab, name-sync, name-lock and song-only post checks)
* `ui-smoke` (light/dark + axe), `csp-check`, `discover-check`, `billboard-check`, `nav-check`, `campaigns-check` (new), `admin-hero-check`, `hero-check`, `splash-check`: pass
* Not run: `sandbox-check` (needs real PayFast/LiveKit/Ozow sandbox keys)
* `features-check`: pass with the large sample image (`BIG_IMAGE`). With its tiny default image the cropper check fails, the same as on the previous commit.
* Not run: lint (the repo has no ESLint config), tests against the live database, real LiveKit, real devices.

## 5. Readiness

**BLOCKED — ACTION REQUIRED.** Code-wise this is ready for **staging validation**, but production has three blockers:
(1) the live site's secure chat stays broken until this branch is merged and deployed; (2) migrations 15–17 must be
applied, 17 together with the deploy; (3) nothing here has been tested against the live database, real LiveKit or real
devices. Campaign billing does not exist, and organisations cannot pay for campaigns yet.
