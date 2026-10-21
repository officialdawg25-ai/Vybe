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

## 2. Brief sections: what exists versus what is asked

| Area | Status | Notes |
|---|---|---|
| Canonical avatar (`profiles.avatar_path`, private bucket, signed URLs with retry and refresh in `useSignedState`) | PARTIAL | One field and one `Avatar` component are used across feed, comments, chat, rail, notifications and search. Own changes now propagate instantly (liveProfiles). **Missing:** realtime propagation of *other* users' changes, and image variants/thumbnails (Supabase image transforms depend on the plan, not checked). |
| Feed pagination, prefetch, caching | PARTIAL | Feed is paged. Signed URLs are cached in memory. **No** measured baseline exists yet (LCP/INP/CLS). None is claimed. PROPOSED: Lighthouse/Web Vitals run on the deployed site with the result recorded here. |
| Story rail (stack on the left, expand right, close once, story-vs-profile slot) | VERIFIED (mocked browser tests) | Expand/close, ordering, reduced motion and no overflow are covered by `social-check`. |
| Post creation → Home with "Post shared" | VERIFIED → improved | Returns to Home with the confirmation "Post shared". The Post button is disabled while posting, and failures keep the draft. **Missing:** idempotency key for uncertain network outcomes (PROPOSED). |
| Home billboard with empty fallback | VERIFIED (`billboard-check`) | `promo_slides` with `draft/live/paused`, schedule, server-side eligibility, deduplicated impressions/clicks per user per day (`promo_track`). |
| Discover promotional hero | MISSING | Discover has no hero. PROPOSED next step: add a `placement` column (`home`/`discover`) to `promo_slides`, reuse the billboard component and admin editor, and add a Discover-specific fallback. This needs a migration and your approval. |
| Campaign engine (draft → review → approved → scheduled → live, org submissions, billing) | PARTIAL | Admin-managed slides only, with no org submission or review states. PayFast exists for tickets and badges, not ads. **No** ad billing exists, so none is claimed. |
| Organisation workspace | PARTIAL | Org portal, members with roles (`owner` and others), org posts, ticketing/finance. **Missing:** campaign submission, invitations/ownership transfer UI, org audit view. |
| Admin workspace | PARTIAL | Admin portal: hero/billboard, reports, finance/refunds, verification. **Missing:** campaign review queue, feature flags, retention workflows. |
| Messaging security model | VERIFIED (unit + DB tests) | True E2EE for opted-in 1:1 and group chats: ECDH P-256 identity keys (non-extractable, in IndexedDB), HKDF, AES-GCM bound to conversation/sender/epoch, per-epoch group keys sealed per member, security codes, key-change warnings, encrypted attachments, LiveKit E2EE calls. Uses WebCrypto primitives; it is **not** the Signal protocol (no forward secrecy per message / double ratchet). Plain chats remain transport-encrypted, server-readable. |
| Recovery | VERIFIED (tests) | Passphrase backup (PBKDF2 600k), recovery key, and **opt-in** VYBE-assisted recovery: 72 h wait, password re-check, cancellable, audited. The escrow is off by default and needs `CHAT_ESCROW_SECRET`. While it is on, VYBE operators could recover that user's key, and the UI says so. An account password reset alone never restores encrypted history. |
| Security headers / CSP | VERIFIED (`csp-check`) | `public/_headers`: CSP with hashed inline script, frame-ancestors none, HSTS, nosniff, Permissions-Policy. |
| RLS | VERIFIED (145 DB tests on PGlite) | Tests run against the migrations, not the live database. |
| Profile column exposure | PARTIAL, privacy finding | `profiles` is selectable as a whole table by signed-in users, including `lat/lng` (city centre), `notif_prefs` and `intents`. PROPOSED: column-level select grants plus a public view. This needs care because many `select('*')` reads depend on it. |
| Rate limits | PARTIAL | Post/comment/message throttles exist in SQL (`capacity-throttles`). Recovery is rate-limited. Supabase Auth limits are dashboard settings, not checked. |
| POPIA | PARTIAL | Data export, account deletion, privacy page, audience controls exist. No documented assessment, operator agreements or breach procedure, so **no compliance claim is made**. |

## 3. Database changes in this change

`supabase/migrations/20261028000015_posts_names.sql` (manual copy:
`supabase/manual/run-in-order-10/01-posts-and-name-limit.sql`). Non-destructive: no rows are rewritten.

* `posts`: drop `posts_check`, add `posts_has_content`.
* `profiles`: add `display_name_changed_at timestamptz` (not client-writable), function `limit_display_name_change()`
  (security definer, `search_path = public`, execute revoked from clients), trigger `trg_limit_display_name`.
* Rollback: `alter table public.posts drop constraint posts_has_content, add constraint posts_check check (body <> '' or
  media_path is not null);` (fails if song-only posts exist, so delete or edit them first), then
  `drop trigger trg_limit_display_name on public.profiles; drop function public.limit_display_name_change();
  alter table public.profiles drop column display_name_changed_at;`.

## 4. Checks run for this change

All commands were run locally in this session against a production build pointed at a mocked Supabase:

* `npx tsc --noEmit -p .`: pass
* `npx vitest run`: 12 files, 272 tests pass (unit + DB)
* `SQL_SOURCE=chunks npx vitest run tests/db`: 145 pass (the pasteable SQL pieces)
* `node scripts/social-check.mjs`: all pass, run 3 times (includes the new two-tab, name-sync, name-lock and song-only post checks)
* `ui-smoke` (light/dark + axe), `csp-check`, `discover-check`, `billboard-check`, `nav-check`: pass
* `features-check`: pass with the large sample image (`BIG_IMAGE`). With its tiny default image the cropper check fails, the same as on the previous commit.
* Not run: lint (the repo has no ESLint config), performance measurements, tests against the live database or LiveKit.

## 5. Readiness

**BLOCKED — ACTION REQUIRED.** The live site's secure chat is broken until this branch is merged and deployed. Migration 15
must be applied for song-only posts and the name rule. The Discover hero and the campaign/organisation workflows are not
built yet, and no performance baseline exists.
