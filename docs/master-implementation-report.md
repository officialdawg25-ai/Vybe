# VYBE master implementation: report

Branch `ccr-4ba6d335-b6gien`, 2026-10-22. This report covers the "VYBE master implementation" brief (Parts A–K), including the
second round (migrations 20 and 21, the media worker, library, resume after reload, organisation communities and notification
settings, advisor fixes, faster banner). The earlier audit is still in `docs/production-readiness-audit.md`.

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
| Media: processing worker with status (uploaded → processing → ready / failed) | VERIFIED (unit + DB + mock) | `media-process` Edge Function: checks the real bytes (type by magic bytes, real size from storage, image dimensions, MP4 duration and frame size, thumbnail exists); only it can set the status (migration 20); 9 unit tests |
| Media: thumbnails and video posters | VERIFIED (mock, real WebM clip) | Made on the device from the picked file (no extra download), uploaded to the member's own folder; posts store `post_media.poster_path`; feed shows the poster first |
| Media: transcoding to other formats/resolutions | BLOCKED | Needs a media service (e.g. Cloudflare Stream or Mux: an account, API keys and per-minute costs). Not possible inside an Edge Function's limits |
| Media: resume after a page reload | VERIFIED (unit + mock) | The upload session is remembered for 23 h (`resumeStore`); after a reload the composer says which upload stopped, and picking the same file continues from the server's offset (no restart). The browser cannot reopen a file by itself, so the member re-picks it |
| Media library (`media_assets`) | VERIFIED (DB + mock) | Personal library at `/app/media`, organisation library in the portal (shared with its members); published post media is added automatically; deleting never removes a file something still shows |
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
| Org Portal: communities owned by an organisation | VERIFIED (DB + mock) | `communities.organization_id`; owners/admins create communities as the organisation or bring in one they own (`set_community_organization`, audited); organisation owners/admins moderate them as community admins |
| Org Portal: per-member notification settings | VERIFIED (DB + mock) | New members, people going to its events, new followers, campaign decisions; on for owners/admins, opt-in for editors; account-wide settings still apply |
| Org Portal: media library | VERIFIED (DB + mock) | Media tab |
| Advisor findings | VERIFIED (DB) / BLOCKED (one setting) | Migration 21; leaked-password protection is an Auth dashboard switch (see below) |
| Live database and deployment | See "Deployment" below | |

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
- **Media library and worker:** status is writable only by the worker (service role); members can insert only files in their
  own folder and only into organisations they belong to; organisation files are readable by its members only (storage rule
  runs under the reader's RLS). The worker reads the asset *as the caller* first, so nobody can have someone else's file
  processed. Deleting from the library never deletes a file a post, profile, event, community or page still shows.
- **Organisation communities:** only the community's owner can move it into an organisation they manage; only the
  organisation's owners/admins (or the community owner) can take it out; both are audited.
- **Advisor (migration 21):** trigger functions are no longer callable over the API (20 findings), `trg_friendship_lock` has
  a fixed search_path, 95 policies evaluate `auth.uid()` once per query instead of per row, and every foreign key has an index
  (47). Left as they are, on purpose: 7 service-role-only tables with no policy (no browser access is the intent), the app's
  own RPC functions (each checks the caller), `get_auth_hero()` for the signed-out sign-in page, 16 "unused" indexes (no
  traffic yet), and 6 tables with two permissive policies (merging them rewrites who sees what for negligible gain).
- **Still open (needs you):** leaked-password protection is an Auth setting, not SQL: Supabase Dashboard → Authentication →
  Providers → Email → "Prevent use of leaked passwords" (available on the Pro plan and above). `profiles.avatar_path` and
  `cover_path` still have no "own folder" rule like organisation images.
- **Configuration drift:** the live `media` bucket allows 250 MB, but migration 2 says 50 MB. The app limits uploads to 25 MB
  images and 50 MB video.

## Performance, round 2 (same method)

The Discover banner's largest paint was late for three reasons, found by tracing requests and paints (not by guessing):
its data was requested only after its code had downloaded; Discover's code was split into ~20 one-icon files that queued on a
slow connection; and the first slide faded in from transparent over 0.45 s. Now the data is requested as the page starts
(`prefetchBillboard`), all icons are one file, the banner renders with the page, and only later slides fade.

See the table at the end of this report for the final numbers.

## Performance, round 1 (lab: same machine, mocked backend, 4× CPU, ~1.6 Mbps, medians of cold loads)

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

## Performance, final (same machine and method; lab numbers vary by roughly ±0.3 s between runs)

| Route | Before round 2 | After round 2 (two runs) |
|---|---|---|
| Home `/app` | LCP 3016 ms · 68 requests | LCP 2568 / 2328 ms · 55 requests |
| Discover | LCP 2944–3064 ms (≈ 0.5 s after first paint) · 59 requests | LCP 2732 / 2324 ms (0–0.12 s after first paint) · 46 requests |
| Messages | LCP 2560 ms · 44 requests | LCP 2508 / 2156 ms · 33 requests |

CLS stays 0.028 everywhere. JavaScript is ~15–20 KB larger per route: the icons are now one shared file (cached once for the
whole app) and the library code. The banner's largest paint now arrives with, or right after, the page's first paint.

## Deployment

Recorded in the pull request and in the final reply of this session: migrations 19–21 applied to project
`ukgtcungmisthtmknxni` with their check tables, the `media-process` function deployed, and the site deployed through the
"Deploy to Cloudflare" workflow. Pasteable copies are in `supabase/manual/update-19|20|21/run-me.sql`
(generated by `scripts/sql-updates.mjs`).
