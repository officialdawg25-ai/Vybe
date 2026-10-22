# VYBE master implementation: report

Branch `ccr-4ba6d335-b6gien`, 2026-10-22. This report covers the "VYBE master implementation" brief (Parts A–K). The earlier
audit is still in `docs/production-readiness-audit.md`.

Labels: **VERIFIED** means confirmed by tests or checks listed here. **PARTIAL** means some of it works. **NOT IMPLEMENTED**.
**BLOCKED** means it needs access, infrastructure or approval.

Browser checks use a **mocked** backend: they prove what the UI does and what it sends. Database rules are proven separately
in PGlite (`tests/db/rls.test.ts`). Nothing in this change has run against the live database or been deployed.

## Status by area

| Area | Status | Evidence |
|---|---|---|
| Media: start uploading on pick, local preview, progress | VERIFIED | `src/pages/CreatePost.tsx`, social-check "Background, resumable uploads" |
| Media: resumable (TUS, 6 MB chunks) for files over 6 MB, resume after a dropped connection | VERIFIED (mock) | `src/lib/upload.ts`, 10 unit tests, social-check (a 14 MB video resumes in one session after a drop) |
| Media: retry with backoff, cancel, at most 3 at once (1 on Save-Data), cover first | VERIFIED | `tests/unit/upload.test.ts` |
| Media: upload kept separate from publishing; a failed upload blocks Post with Retry | VERIFIED | social-check |
| Media: orphan cleanup (removed or abandoned uploads deleted) | VERIFIED for posts and the org logo/cover | social-check, org-check |
| Media: one shared uploader for posts, attachments, songs, campaigns, admin promos, admin music, encrypted chat, org images | VERIFIED | `uploadObject` / `queued` used by every path |
| Media: server-side thumbnails/transcoding, processing status | NOT IMPLEMENTED | No worker infrastructure exists; would need a queue plus an Edge Function or an external transcoder |
| Media: resuming after a page refresh | NOT IMPLEMENTED | The browser drops the File object on refresh; would need IndexedDB plus re-picking |
| Media library (`media_assets` table) | NOT IMPLEMENTED | Not built, to avoid a second media system next to storage paths |
| Discover: always-visible search, location, For you / Nearby / Trending / Following | VERIFIED | discover-check |
| Discover: swipeable category tiles (admin categories reused), keyboard and desktop arrows, real cover art, no page scroll | VERIFIED | discover-check (36 checks incl. keyboard, URL, overflow at 3 sizes) |
| Discover: shareable URL `?cat=…&f=…`, old `?mode=` links still work | VERIFIED | discover-check |
| Discover: Trending uses the documented server score, labels only real activity | VERIFIED (mock) | `trending_events` (migration 9) |
| Discover: personal livestreams stay on Home | VERIFIED | Live tile lists event broadcasts only (`discover_live`) |
| Events, artists, communities: one event model, follow/RSVP/save persist | VERIFIED (existing) | discover-check; no second event engine added |
| Org Portal: Overview with real counts (money and campaigns for owners/admins only) | VERIFIED (DB + mock) | `org_overview`, DB test, org-check |
| Org Portal: identity (logo, cover, website, up to 5 links, location) persists | VERIFIED (DB + mock) | migration 19, DB tests, org-check |
| Org Portal: owners change roles, audited | VERIFIED (DB + mock) | `set_org_member_role`, DB tests, org-check |
| Org Portal: history of changes | VERIFIED (DB + mock) | `org_activity`, DB test, org-check |
| Org Portal: events, page posts, check-in, campaigns, finance, members | VERIFIED (existing) | already in the portal |
| Org Portal: communities owned by an organisation | NOT IMPLEMENTED | `communities` has no `organization_id`; adding ownership is a schema decision for you |
| Org Portal: notification settings per organisation, media library | NOT IMPLEMENTED | |
| Migration 19 on the live database | BLOCKED (needs your approval) | `supabase/manual/update-19/run-me.sql` is ready |
| Deployment | NOT DONE | Nothing merged or deployed in this round |

## Source of truth

| Data | Where it lives | Written by |
|---|---|---|
| Discover categories | `event_categories` (admin) | Admin portal |
| Selected category and filter | the URL (`?cat=`, `?f=`) | Discover |
| Event results | `discover_events` RPC (RLS-checked) | Server |
| Trending | `trending_events` RPC: 3×tickets sold in 7 days + 2×new "going" in 7 days + 0.5×total going + 5 if within 14 days | Server |
| Organisation identity | `organizations` row (new: `cover_path`, `website`, `links`, `location`) | Owners and admins (RLS + column grants + `org_guard`) |
| Organisation roles | `organization_members.role` | Owners only, through `set_org_member_role` |
| Organisation history | `audit_log` (triggers `org_audit`, `org_member_audit`, existing `promo_audit`) | Database triggers only |
| Overview numbers | `org_overview` (aggregates) | Server |
| Media files | Storage bucket `media`, path `<uploader id>/<random>` | The uploader (storage policy) |

## Security review (this change)

- **Org images:** a logo or cover must be in the saver's own upload folder (`org_guard`). An admin cannot point the page at
  someone else's file to make it readable. Tested.
- **Org links:** the website and links must be `https://` (checked by the database, not only the form), so `javascript:`
  links are refused. Public links open with `noopener noreferrer nofollow`.
- **Roles:** only the owner can change a role, nobody can become owner or change their own role, and direct role writes
  stay closed (no column grant). Tested.
- **Overview:** members only. Sales and campaign figures are owners/admins only, enforced by the server, not just hidden in the UI. Tested.
- **History:** owners/admins only, through a security-definer function. The audit table itself stays staff-only.
- **Media read rule:** extended with organisation logo/cover. Everything else is unchanged; signed-out access is still none.
- **Uploads:** the client never chooses another member's folder (storage policy), uses `x-upsert: false` (no overwrite) and
  holds no service key.
- **Found and fixed during testing:** the Overview crashed when the server returned an unexpected reply. It now shows an
  error instead of crashing, and never fills gaps with zeros.
- **Pre-existing, not changed (reported):** `profiles.avatar_path` and `cover_path` have no "own folder" rule like the one
  added for organisations. Advisor findings from the last audit still stand: leaked-password protection is off, and
  `trg_friendship_lock` has a mutable search_path. A clean-up migration is on offer.
- **Configuration drift:** the live `media` bucket allows 250 MB, but migration 2 says 50 MB. The app limits uploads to 25 MB
  images and 50 MB video.

## Performance (lab: same machine, mocked backend, 4× CPU, ~1.6 Mbps, medians of cold loads)

| Route | Before (last commit) | After |
|---|---|---|
| Home `/app` | FCP 2592 ms · LCP 2956 ms · CLS 0.028 · 544 KB JS · 66 requests | FCP 2636 ms · LCP 3016 ms · CLS 0.028 · 544 KB JS · 68 requests |
| Discover | FCP 2388 ms · **LCP 2388 ms** · CLS 0.028 · 519 KB JS · 54 requests | FCP 2500 ms · **LCP 2944 ms** · CLS 0.028 · 532 KB JS · 59 requests |
| Messages | FCP 2432 ms · LCP 2524 ms · CLS 0.028 · 542 KB · 44 requests | FCP 2560 ms · LCP 2560 ms · CLS 0.028 · 542 KB · 44 requests |

**Discover's LCP is about 0.55 s later.** The largest element on screen is now the hero banner's title. Before, it was the
old header's large text block, which painted with the first frame.

- The hero loads exactly as it did before. Two experiments made no difference: removing the tile-art request, and starting
  the hero download earlier.
- So this is mainly a change in *which* element is measured, not a slower page. It still means the biggest thing on screen
  arrives later.
- The real fix is to show the house slide straight away instead of a placeholder. I left that out because a sponsored slide
  could then replace it a moment later.
- The other routes are within run-to-run noise. Discover's JavaScript grew by 13 KB, for the tiles and the new views.

## Tests and checks run on the final code

- Unit and database tests: **320 passed**, including 8 new database tests for migration 19. The database suite also passes
  when migration 19 is applied from `supabase/manual/update-19/run-me.sql`, and that file's check table returns true on
  all five rows.
- Browser checks, all passing (mocked backend):
  - New: discover-check (rewritten for the tiles), org-check (32 checks).
  - Existing: billboard, social, ui-smoke (every route, plus axe accessibility), nav, hero, production, campaigns, csp,
    features, admin-hero, splash.
- One existing check was changed: production-check looked for the removed "Explore:" label. It now checks the same thing,
  that the hero leaves search and the category tiles on the first screen, by measuring their position.

## To finish (needs you)

1. **Approve applying migration 19:**
   - Paste `supabase/manual/update-19/run-me.sql` into the SQL editor; every row of the check table should say true.
   - Until it is applied, the portal still works: it says which parts need the update and still saves the name and About.
2. **Review and merge the PR, then deploy** through the existing GitHub Actions workflow.
3. **Decisions:**
   - Should communities be ownable by an organisation?
   - Do you want a processing worker for video thumbnails and transcoding? It needs infrastructure the project doesn't have yet.
   - Should profile pictures get the same "own folder" rule as organisation images?
   - Should I write the advisor clean-up migration?
