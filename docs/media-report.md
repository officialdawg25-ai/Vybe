# Posts, Reels and synced audio — implementation report

Repository `officialdawg25-ai/Vybe`, branch `claude/share-memory-reel-ux-t1gvap`.

- **Round 3** (real quality choice, auto-advance, volume, accessibility; migration/update 35): see the PR that adds this section, and the "Round 3" part below.

- **Round 1:** PR #29, squash-merged to `main` as `56423b6`.
  - Database update 34 was applied by the "Apply database update" workflow (run 12, success) and checked afterwards with read-only queries.
  - The app was deployed by "Deploy to Cloudflare" (run 23, success) as Worker version `92437f75-a906-4064-a19f-8a99d2da42dd`.
- **Round 2** (recovery, preloading, performance tests, this report): see the PR that adds this file.

This sandbox's network proxy blocks `workers.dev`, so I could not load the live site from here. Deployment evidence is the workflow log, not a page load.

## Baseline (measured on `main` 6c42aeb before any change)

Measured in Chromium against a mocked API that serves real media files, using `scripts/media-harness.mjs`.

| Defect | Measured |
|---|---|
| Feed post, video + song, slow video | Song playing at 247 ms; video first frame at 4053 ms |
| Reel, video + song, slow video | Song at −9 ms; video at 4000 ms |
| Tap on a feed video | Nothing happens; no route to Reels |
| Reels deep link to a regular video post | Not shown: the lookup filtered to `is_reel = true` |
| Multi-photo post | Portrait slide rendered 693 px tall inside a 488 px frame, so it was cropped |
| Photo viewer | None |
| Song-only post | Allowed: migration 15's `posts_has_content` accepted a song on its own |

Production data check (read-only): 18 posts. None was song-only, used another member's file, or referenced a missing storage object.

## Root causes

1. **Song before video.**
   - In the feed, `lib/feedSound.resume()` called `audio.play()` as soon as the post was on screen, whatever the video was doing.
   - In Reels, `useSongPlayer` started the song on `active && !paused`, not when the video was actually playing.
   - Neither listened to the video's `waiting`, `seeking` or `error` events.
2. **No route into Reels.** `PostMedia` only handled double-tap likes. The Reels `start` lookup used `fetchPosts({ reels: true })`.
3. **Cropping.** In multi-photo galleries, slides used `height: 100%` inside a grid row whose height did not resolve. Video posters used `background-size: cover`.
4. **Song-only posts.** The database rule (migration 15) counted `music_path`, `feeling`, `place` or tags as content. The composer did the same.
5. **Feed video stuck on its first frame (found while testing; present on `main`).**
   - The `<video>` `src` was `poster ? url : url#t=0.1`.
   - When the poster's signed URL arrived after playback had started, the `src` changed. The browser restarted the load, which rejected the pending `play()`.
   - The video then stayed paused, and its song (correctly) never started. Reproduced in 5 of 12 runs, then 0 of 12 after the fix.
6. **Reels neighbours re-downloaded.** A neighbour's `<video>` was removed the moment you swiped, and added back once the new reel played. Each reel was therefore downloaded about twice (20.5 MB for 20 reels of 0.51 MB).

## What changed

**`src/lib/syncAudio.ts` (new): the video is the song's clock.**
- The song starts only on the video's `playing` event (frames moving, not seeking).
- It pauses on `pause`, `waiting`, `seeking`, `error`, `emptied` and `ended`, and also when the video's clock silently stops (a 200 ms watchdog, 400 ms threshold).
- It re-aligns after seeks and loops.
- Speed changes carry over: song rate = video rate ÷ creator speed.
- Drift is corrected by nudging the song's rate ±5 % for offsets over 40 ms, and by seeking for offsets over 250 ms.
- A hidden tab pauses all media.
- Duration mismatch: the song loops inside its clip and never runs past the end of the file. A looping video loops the song with it.

**`src/lib/feedSound.ts`:** the feed's single song player binds to the video on screen of the post that owns the sound. A photo post's song plays freely, as before.

**`src/components/PostMedia.tsx`:**
- Single tap on a video opens `/app/reels?start=<id>&t=<seconds>`; double tap still likes.
- Videos get an expand button, a progress line, a buffering spinner, error with Retry, an offline state, and a "taking longer" hint.
- Single tap on a photo opens the viewer.
- Galleries use `object-fit: contain` in a fixed frame, and posters use `contain`.

**`src/components/MediaViewer.tsx` (new):** shows the original upload. Pinch, double-tap and Ctrl+wheel zoom, panning, swipe or arrow keys between photos, swipe down / Escape / × to close, a counter, and focus return.

**`src/pages/Reels.tsx`:**
- Deep links work for any post with a video, resuming from `t`.
- Clear message when the post is unavailable.
- The song is bound to the video.
- Buffering, error/Retry, offline and slow states.
- Full screen.
- Keyboard: Space/K, M, F, ←/→ 5 s.
- When paused, shows the real resolution of the single file.
- Neighbours stay loaded while adjacent.

**`src/lib/mediaRecovery.ts` (new):**
- An expired link is re-signed once silently, and playback continues from the same moment.
- Offline waits for the connection, then retries.
- No first frame after 12 s shows "Taking longer than usual" with Retry.
- The `src` stays fixed until a retry, so the hourly re-sign never reloads a playing video.

**Publishing rules (`src/lib/postRules.ts`, CreatePost, Composer; migration 34 / update 34):** see the next section. A retried publish reuses its post and never inserts the gallery twice.

## Schema change (migration 34, applied as update 34)

- `meaningful_text(text)`: text that still has content after removing spaces, invisible characters, punctuation, symbols and emoji.
- `posts_has_meaningful_content`: meaningful text **or** a photo/video. This replaces migration 15's rule, which a song alone could satisfy.
- `posts_media_path_owner`: the file must sit under the author's own folder and be an image or video.
- Triggers `posts_media_uploaded` and `post_media_uploaded`: the storage object must exist, so a failed or unfinished upload cannot publish. Their execute permission is revoked from the API roles.
- `posts.client_key` plus a unique index on `(author, client_key)`: a retried publish is idempotent.
- Backward compatible: older app versions omit `client_key`, and the new app falls back if the column is missing. Existing posts were checked first; all constraints validated.
- Rollback: drop the two constraints, the two triggers and the index; restore `posts_has_content`.
- Tests: `tests/db/rls.test.ts`, "migration 34" suite, covering the table in the brief (empty, whitespace, short text, photo/video without caption, video + song, song alone, failed upload, someone else's file, duplicate publish).

## Tests run (final state of this branch)

- `tsc --noEmit`: clean.
- Vitest: **511/511**. This includes the DB suite on PGlite and the unit tests for `songTimeFor` and the publishing rules.
- `npm run build`: OK.
- `scripts/media-check.mjs`: **68/68**, in three consecutive runs. Each scenario uses its own browser.
- `scripts/round9-check.mjs`, `round10-check.mjs`, `round11-check.mjs`: pass.
- `social-check`, `features-check` and `ui-smoke` fail at the same steps on an unmodified `main` build, so those failures are pre-existing (stale selectors), not regressions.
- The "Workers Builds: vybe" GitHub check fails instantly on every PR (also #28). It is Cloudflare's Git integration, not the deploy path, and its log is only in the Cloudflare dashboard.

### Sync measurements (|song − expected position|, sampled every 50 ms)

| Scenario | p95 |
|---|---|
| Start after a slow video | Song 2–11 ms after the video's first frame |
| Reel, steady | 2–11 ms |
| Feed, steady | 27–35 ms |
| Resume / seek / loop | 19–38 ms |
| 2× speed | 6–31 ms |
| Next reel | 40–57 ms |
| After a silent freeze | 45–49 ms |

The constant ~30 ms feed offset is between two separate media elements and is within the 100 ms target. Browser scheduling makes sub-10 ms alignment between two elements impractical.

### Performance

Local server and mocked API. Treat these as relative numbers, not real-network numbers.

| Measure | Result | Target |
|---|---|---|
| Reels first frame, cold (5 fresh browsers) | p75 **256 ms** | ≤ 1500 ms |
| Reels first frame, warm (reload) | p75 **151 ms** | ≤ 500 ms |
| Slow-link profile (300 ms RTT, 1.6 Mbit/s) | p75 **3.1 s** | none set |
| 20-reel session: elements | max 3 `<video>`, 1 playing video, 1 playing song, 1 loaded song | bounded |
| 20-reel session: JS heap after GC | 6.1 → 7.3 MB | no unbounded growth |
| Preloading, 20 reels watched | 10.7 MB for 20 × 0.51 MB files (was 20.5 MB) | ~1× per reel |
| Preloading at rest | current reel and the next one only | ≤ 2 |
| Home → video → Reels → Back | scroll restored (2072 → 2072 px) | restored |

The slow-link number is pessimistic. The mock sends each response whole after the simulated transfer time, so the first frame waits for the entire 0.5 MB file. A real server streams progressively and shows the first frame after the first chunks. I did not measure a real phone or a real mobile network from this sandbox.

## Round 3: real quality choice, auto-advance, volume, accessibility

**Quality without a server transcoder.**
- After a post or reel is published, the uploader's device makes a smaller copy of each video (`src/lib/videoCopy.ts`).
  - It plays the original once, hidden and silent to the speakers, draws its frames onto a ≤480p canvas, routes its sound through Web Audio, and records both with MediaRecorder.
  - It records MP4 where the browser can, otherwise WebM. Chrome's WebM recordings have no duration header, so the copy maker writes one in (a small EBML patch).
  - The copy is used only if it loads, matches the original's duration within 1 s, can seek to its middle, and is at most 65 % of the original's size.
  - It is uploaded to the author's folder and attached as `post_media.display_path` (`src/lib/videoCopyAttach.ts`).
  - Publishing never waits for it. Videos already light enough get no copy, and low-end devices skip it.
- **Migration 35 / update 35:**
  - A video's gallery row may carry the copy.
  - Authors get column-level `UPDATE` on `display_path` only.
  - A trigger requires the copy to be the author's own finished upload with a `video/*` MIME type, and never the original itself. Photo copies keep requiring `image/*`.
  - Reading needed no change: `media_select_visible` already covers `display_path`.
  - DB tests cover attaching, unfinished uploads, a photo used as a video copy, the original itself, someone else's file, other members' rows, and the author changing other columns.
- **Viewers (`src/lib/videoQuality.ts`):**
  - Options are Auto, Original and Data saver, shown in the Reels options **only when the copy exists and this browser can play it**.
  - Auto uses the copy on Data saver or a low-end device (the existing Settings → data mode), or for the rest of the visit after two stalls within a minute. It does not flip back and forth.
  - Switching keeps the playback moment and keeps one song session.
  - A copy that fails falls back to the original without showing an error.
  - Feed videos follow Auto, and feed batch signing requests the file that will actually play.
- **Bug found while testing:** on a quality switch, the player briefly had the previous file's signed URL and pinned it under the new file's name. `useSignedState` now reports which path its URL belongs to (`forPath`), and players use only a matching URL.

**Reels options:**
- "Play the next reel automatically" is an opt-in switch; reels loop by default, as before.
- A volume slider sets the video and its song together. It is hidden where the browser ignores element volume (iOS).
- Both are per-device settings.

**Accessibility:** axe-core now runs on the reel player, the options sheet, the photo viewer and a feed video. The Like and Comments buttons' spoken names didn't contain their visible counts (WCAG 2.5.3). They are now "Like 3" and "Comments 0". Like and Save keep one name and expose their state with `aria-pressed`.

**Evidence (round 3):**
- `scripts/video-copy-check.mjs`: **13/13**, running the real `videoCopy.ts` in Chromium on a 1080×1920, 8 s, 5.4 MB VP9/Opus video.
  - As recorded (MP4): 480×854, 7.96 s, 473 KB (9 % of the original), Opus sound, plays and seeks.
  - WebM forced: 480×854, duration written in (8.008 s), 466 KB, plays and seeks.
  - Made in 8.3 s, about the video's length.
  - A light 360×640 video gets no copy.
- `scripts/media-check.mjs`: **86/86** in two consecutive runs. New checks:
  - Quality: the original plays on Auto with a normal connection. The menu shows exactly Auto / Original / Data saver.
  - Switching to Data saver plays the copy from the same moment, with one song at 4 ms p95.
  - Data saver mode downloads only the copy, never the original.
  - A broken copy falls back to the original, and a video without a copy offers no choice.
  - Auto-advance is off by default (the reel loops) and works when switched on. The volume slider moves video and song together.
  - Rapid switching through six reels settles on one video and one song in sync (33 ms p95), with at most 2 video elements left.
  - axe finds no serious or critical violations.
- Vitest: **529/529**. That is 277 DB tests (including migration 35) plus unit tests for the quality rule, the copy plan and the WebM duration patch.
- Build OK. round9/10/11 pass. round3 passes its Reels checks, then stops at a reel-upload label that no longer exists (stale since the reel camera redesign).

## Known limitations and work not done

- **Quality selection.** Real now where a copy exists: Original and a ≤480p device-made copy. There is no adaptive streaming (HLS/DASH) and no 144p–1080p ladder.
  - Copies are made only for posts published from this version on, by uploader devices that can record (MediaRecorder plus Web Audio; skipped on low-end devices or if the tab is hidden while recording).
  - Older videos have no copy, so they show no choice.
  - A copy recorded in VP9 may not play on some Safari versions; there it falls back to the original.
- **Server-side mixing of song and video.** Supabase Edge Functions have no ffmpeg, so there is no in-stack worker for it. Playback uses the coordinated client player above. A composed file would need an external media service, which means cost and licensing decisions for you.
- **Processing states.** No server job processes media. The smaller copy is made after publishing, and the original plays until the copy exists, so viewers never wait on processing. Uploads are checked for existence by the database.
- **Volume.** The slider appears where the browser honours element volume. On iOS, mute is the control. The creator's original/song mix (`reel_edit.ov` / `mv`) is applied under the viewer's volume.
- **Real-device testing.** No Android or iOS device runs were possible here. Playwright's Chromium has no H.264/AAC, so the fixtures are WebM.
- **Previously open, unchanged:** SMTP email is blocked by the provider's IP allowlist, and the Ozow logo needs `public/brands/ozow.svg`.
