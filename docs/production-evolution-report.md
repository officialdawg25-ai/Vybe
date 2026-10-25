# VYBE production evolution — engineering report (2026-10-25)

Scope: the "real-world production evolution" brief (live video quality, feed speed, reels playback, billboard, caching, slow
networks, low-end devices, security). This report separates what was **measured** from what is **built but not yet
measurable here** and what is **blocked**. Nothing in the tables is estimated: missing evidence says NOT MEASURED.

## A. Repository and architecture findings

**Confirmed stack.** React 18 + Vite 8 + TypeScript SPA, deployed as static assets on the Cloudflare Worker `vybe`
(`wrangler.jsonc`, workflow "Deploy to Cloudflare"). Supabase project `ukgtcungmisthtmknxni` (eu-west-2, Postgres 17,
**Free plan**) for auth, data, RLS, Storage and 12 Edge Functions. LiveKit for live and calls (`livekit-client` 2.23.0);
production LiveKit is configured (3 streams have started and ended through the LiveKit webhook). Production data is small
(6 posts, 1 reel, 34 media objects / 64.5 MB), so database plans at scale cannot be observed in production.

**Systems reused, none duplicated.** Supabase stays the data authority (no new tables, no migration this round); the existing
signed-URL cache, resumable uploads (`lib/upload.ts`), feed snapshot cache, billboard prefetch, LiveKit token gate
(`live_token_gate`: per-user rate limit, host-only publish, viewer ceiling) and error boundaries are all reused.

**Request paths (traced).**
1. App launch → `index.html` → 6 initial chunks (~176 KB gzip JS+CSS) → session from storage → `my_profile` → route chunk.
2. Feed → `fetchPosts` (one PostgREST query per page with embedded author, counts, media; RLS decides visibility) →
   cursor pagination (15/page) → one batched `createSignedUrls` per page → private media from the `media` bucket.
3. Upload → `uploadMedia` (resumable for large files, progress, cancel) → own folder in `media` → row references the path →
   `media-process` sniffs bytes/size (library assets). No transcoding (see G).
4. Reel playback → signed URL of the original MP4/WebM → progressive download with byte ranges (no adaptive renditions).
5. Live → `livekit-token` Edge Function (DB gate as the user) → LiveKit room → simulcast publish → adaptive subscribe.
6. Billboard → `promo_slides` (RLS) + `home_hero_settings` + `trending_events`, prefetched with the page.
7. Private media → short-lived signed URLs (1 h), re-signed before expiry; storage policy `media_select_visible`.

**Bottlenecks found (measured or read in code).**
| # | Finding | Evidence |
|---|---|---|
| 1 | The first feed page waited for two sequential steps: the profile check, then Home's code download, and only then asked for posts | request waterfall: posts at 2534 ms, profile at 1485 ms, Home chunk at 1838 ms |
| 2 | Posts were not rendered until the page's signing batch returned (one extra round trip before any text) | `Feed.tsx` awaited `primeSignedUrls` |
| 3 | Cursor was `created_at` only: posts sharing a timestamp could be skipped or repeated between pages | `posts.ts` |
| 4 | Live capture used the SDK default **720p** (no capture size set) | `livekit-client` default `videoCaptureDefaults = h720` |
| 5 | Desktop live screen was a 520 px column with `object-fit: cover`: landscape streams were cropped and viewers were capped at 720p even on a Full HD screen | live end-to-end run: video element 520×480 on a 1920×1080 window, received 1280×720, 1080p layer paused |
| 6 | No camera/microphone failure states, no "tap for sound" when autoplay blocks audio, no connection-quality state | `LiveRoom.tsx` |
| 7 | Billboard query relied on RLS only, which also lets admins and organisation campaign managers read drafts and ended slides — they saw those in the public billboard | `promo_read` / campaigns policy vs `liveSlides()` |
| 8 | Billboard never refreshed while open | `useBillboard` loaded once per mount |
| 9 | Reels: on a slow link the next reel's preload competed with the first reel for bandwidth | reels lab: first reel 4217 ms with preload vs 3318 ms without |
| 10 | Reels: a failed *next* page replaced the whole player with an error screen | found by the lab script |
| 11 | Feed videos were never released after scrolling far away (the observer attached before the element existed) | found by round5-check |

**Risks noted, not changed.** Signed URLs differ per signature, so the browser cache cannot reuse private media across sessions
(a property of private buckets). The feed keeps up to 120 posts in the DOM (no virtualization; not justified at current
volumes and not measured as a problem). See G for blocked items.

## B. Changes implemented

| Area | Change | Files |
|---|---|---|
| Feed critical path | When the app opens on Home, Home's code and the first page of posts are fetched alongside the profile check; the page is tied to the account, used once, valid 15 s. Discover/Reels code is warmed the same way | `auth/AuthProvider.tsx`, `lib/posts.ts`, `pages/Home.tsx` |
| Feed render | Posts render as soon as the page arrives; pictures wait on the in-flight signing batch (no duplicate signing calls) | `components/Feed.tsx` |
| Pagination | Compound cursor `(created_at, id)` matching the existing `posts_created_idx (created_at DESC, id DESC)`; values validated and quoted; legacy time-only cursors still work | `lib/posts.ts`, `pages/Reels.tsx` |
| Live publishing | Quality profiles: Full HD 1920×1080@30 (3 Mbps), HD 720p (1.7 Mbps), 480p (0.9 Mbps), 360p (0.45 Mbps). Auto chooses by data mode and device (cores/memory/connection hints); host can pick before going live. Portrait phones ask for a portrait frame. Simulcast layers below the top (1080p → 720p + 360p), dynacast, adaptive stream, RED/DTX audio | `lib/liveQuality.ts`, `pages/LiveRoom.tsx` |
| Live states | Camera/microphone permission denied, not found, in use; "Tap for sound" when the browser blocks audio; "Weak connection" from LiveKit connection quality; reconnect count | `pages/LiveRoom.tsx` |
| Live measurement | "Stream quality" panel: requested profile, camera's real size, each simulcast layer as encoded (size, fps, kbps, limitation reason, paused), viewer's received size/fps/kbps/loss/jitter, RTT, time to first video, reconnections | `lib/liveQuality.ts`, `pages/LiveRoom.tsx` |
| Live layout | Full-window live screen on every device; landscape streams shown whole (contain), portrait streams fill a phone | `styles.css` |
| Reels | Neighbouring reels are prepared only after the current one is playing; only active ± 1 hold a `<video>`; a failed next page keeps what is on screen; start-up and stalls recorded | `pages/Reels.tsx` |
| Feed video lifecycle | One feed video plays at a time; videos more than ~2 screens away become a same-size poster (decoder and buffer released); data saver: tap to play, nothing fetched first | `components/PostMedia.tsx` |
| Data modes | Settings → Data & video (this device): Automatic, High quality, Data saver, Device saver; Automatic follows the browser's Save-Data, 2G/3G and low-memory hints | `lib/dataMode.ts`, `pages/Settings.tsx`, `lib/feedCache.ts` |
| Billboard | Only live slides inside their dates are requested; a slide ending while the page is open drops out at its end time; re-check every 5 min while visible and on tab return | `lib/promos.ts` |
| Metrics | Bounded in-memory samples (numbers only): reel start-up/stalls, live first frame, reconnects; p50/p75/p95 helper | `lib/metrics.ts` |
| Tooling | `perf-check` now measures time to first post and signing calls with a simulated 250 ms server time; `reels-perf` (real VP9 reels over a throttled real HTTPS server); `live-e2e` (real LiveKit server); `round5-check` | `scripts/` |

No database migration, no new dependency, no new service. CSP unchanged this round.

## C. Before-versus-after measurements

All lab numbers: same machine, local production builds of `main` (before) and this branch (after) served side by side, Chromium,
phone viewport 390×844 @2×, CPU slowed 4×, cold cache, medians. API mocked with 250 ms server time per call (feed) — lab
numbers, **not field data**.

| Metric | Baseline | After | Test conditions | Evidence |
|---|---|---|---|---|
| App start — first paint, Home | 2636 ms | 2276 ms | 1.6 Mbps / 150 ms RTT, 5 runs | `perf-check` |
| First feed post on screen, Home | 3302 ms | 2414 ms (−888 ms, −27%) | same | `perf-check` ("first post") |
| Discover — first paint | 2624 ms | 2316 ms | same | `perf-check` |
| Reel start-up (first reel, page load → playing) | 1548 ms | 1345 ms | 9 Mbps / 80 ms, VP9 1080×1920 ~4 Mbps, 3 runs | `reels-perf` |
| Reel start-up (first reel) on a slow link | 4217 ms | 3329 ms | 1.6 Mbps / 150 ms, 3 runs | `reels-perf` |
| Next reel (swipe → playing) | 29 ms (4G) · 30 ms (slow) | 30 ms (4G) · 32 ms (slow) | prepared while the previous plays | `reels-perf` |
| Video data per short session (3 reels, ~3 s each) | 6.1 MB (4G) · 1.5 MB (slow) | 5.8 MB (4G) · 1.3 MB (slow) | same | `reels-perf` (bytes received, network layer) |
| Live capture requested | 1280×720 (SDK default) | 1920×1080 (Full HD profile) | code; confirmed below | `livekit-client` defaults; `live-e2e` |
| Live: camera / layers actually sent | NOT MEASURED (old build has no stats) | camera 1920×1080; layers 1920×1080 · 1280×720 · 640×360 | local LiveKit 1.13.11, Chromium fake camera, loopback | `live-e2e` |
| Live: video actually received | NOT MEASURED (old build); by layout the desktop element was 520×480 → 720p | desktop 1920×1080 window: **1920×1080**; phone 390×844: 1280×720 | same | `live-e2e` |
| Live: time to first video (viewer) | NOT MEASURED | 0.3 s after connecting | loopback only — not representative of mobile networks | `live-e2e` |
| Live frame rate | NOT MEASURED | 20 fps (Chromium's fake camera produces 20 fps; 30 fps on real cameras NOT MEASURED) | same | `live-e2e` |
| Feed API p95 latency (production) | NOT MEASURED | NOT MEASURED | no load test against production (not authorised; data volume too small to be meaningful) | — |
| Public media cache-hit rate | NOT MEASURED | NOT MEASURED | needs Cloudflare analytics access (not available to this session) | — |
| Reels page — first paint | 2368 ms | 2128 ms | 1.6 Mbps / 150 ms RTT, 5 runs | `perf-check` |
| Layout shift (CLS), all four routes | 0.028 | 0.028 | same | `perf-check` |
| Requests on Home (images, API) | 53 (4 signing/image requests) | 52 (4) | same | `perf-check` |
| Initial JS + CSS (gzip) | 175.3 KB | 175.8 KB | production build | `gzip -9` of the files `index.html` loads |

Found and corrected during measurement: a first reels-perf run reported 8.1 MB delivered "before first frame" on 1.6 Mbps —
impossible — because mocked responses bypass network emulation. Those runs were discarded; videos are now served by a real
local HTTPS server so the emulated network applies. Also measured and reverted: skipping next-reel preparation in Data saver
did not save data (6.7 MB vs 6.0 MB per session) and slowed the next reel from 29 ms to 449 ms (4G) / 2.7 s (slow), because
the playing reel's buffering dominates; it now only applies on Device saver.

## D. Test results

| Command | Result |
|---|---|
| `npx tsc --noEmit -p .` | pass |
| `npx vitest run` (unit + PGlite RLS/DB) | 19 files, 382 tests passed |
| `scripts/round5-check.mjs` (new) | all passed |
| `scripts/live-e2e.mjs` (new, real LiveKit) | all passed |
| round4, discover, round3, social, org, nav, production, billboard, hero, features, campaigns, admin-hero, csp, ui-smoke | all passed |

Test changes: `social-check` was not changed (the cursor falls back to time for its non-UUID ids); `features-check` theme
radios use exact names (the new data-mode descriptions contain the word "lighter"); `maps.test` unchanged this round;
`live-quality` unit test expectation updated when paused layers became visible in the panel (behaviour change, not weakened).
Regressions found by the new checks and fixed before commit: Reels next-page error (B), feed video release (B), and one of
this round's own: the first image of every post had been set to load eagerly (6 image downloads instead of 3 in the
measurement window); reverted to lazy loading and re-measured.

Not run: Lighthouse/field Web Vitals (no RUM in place); load tests (not against production); real devices (none attached);
Safari/Firefox (Chromium only in this environment).

## E. Security review

- No secrets added to client code. The live token flow is unchanged: tokens come only from `livekit-token`, gated by the
  database as the user; viewers cannot publish; per-user rate limit on token issue.
- RLS untouched. The billboard change *adds* a client filter (status/date) on top of RLS; it does not widen access.
- The feed cursor never places unvalidated input in a PostgREST filter: the time must parse, the id must be a UUID (otherwise it
  is ignored), and values are quoted.
- The early first-page request is per account, single use, 15 s, and runs under the same RLS as any feed request.
- Metrics hold numbers only (no ids, URLs, tokens or content) and stay in the browser.
- Data-mode choice and live quality preference are device-local (localStorage) and never sent anywhere.

## F. Deployment status

- Branch `ccr-4ba6d335-b6gien`, restarted from `main` after PR #17 merged; this round's commit is on top.
- **Production was not changed by this round.** No migration is needed. Deployment needs your go-ahead (merge, then the
  "Deploy to Cloudflare" workflow; Edge Functions unchanged).
- Staging: none exists for this project; all verification ran against local production builds.

## G. Remaining blockers and next priorities

1. **Adaptive bitrate video for reels (HLS) — blocked: needs a transcoding service.** Supabase Free has no media processing;
   Workers cannot run ffmpeg. Options: Cloudflare Stream (HLS/DASH, signed URLs; priced per minute stored/delivered) or Mux.
   Needed: account + API token as an Edge Function secret; a `media_assets`/`post_media` field for the stream id; upload →
   direct creator upload → webhook marks ready. Until then reels are progressive with byte ranges (start-up measured above).
2. **Responsive image variants — blocked on plan or service.** Supabase image transformations need the Pro plan; alternatives:
   Cloudflare Images, or upload-time WebP derivatives stored next to the original (needs a schema field and a storage-policy
   update so derivatives are readable with their post).
3. **Field telemetry (p75 Web Vitals, reel start-up, live first frame) — needs a decision** on destination and retention
   (e.g. a sampled, aggregated `client_metrics` table via an RPC with rate limits, or an analytics provider). The collector
   (`lib/metrics.ts`) is in place.
4. **Large public broadcasts** — current design is interactive WebRTC with a 2000-viewer room ceiling (`LIVE_MAX_VIEWERS`). For
   larger audiences, LiveKit Egress to HLS (needs LiveKit Cloud egress or a self-hosted egress service, plus a CDN) — not
   enabled in the current deployment; not built.
5. **Real-device verification** of 1080p capture at 30 fps on phones, and of live quality on mobile networks (only loopback was
   measured).
6. **Cloudflare analytics access** to report cache-hit ratio by resource type.
