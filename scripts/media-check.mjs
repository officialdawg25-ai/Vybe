// Browser checks for posts, Reels and synced songs, against a MOCKED backend that serves real media files
// (scripts/media-harness.mjs). Build the app with VITE_SUPABASE_URL=https://mock.supabase.test, serve it (vite preview),
// then: MEDIA_DIR=<folder with the fixtures> CHROMIUM_PATH=... node scripts/media-check.mjs
// Fixtures: portrait.webm (8 s, with sound), song.webm (40 s), poster.jpg, portrait/landscape/square/tall.jpg.
// Chromium in Playwright has no H.264/AAC, so fixtures are WebM (VP9/Opus); the logic under test is codec-independent.
import { writeFileSync } from 'node:fs'
import { launch, open, post, AUTHOR } from './media-harness.mjs'

const V = { path: `${AUTHOR}/clip.webm`, type: 'video', poster_path: `${AUTHOR}/poster.jpg` }
const BROKEN = { path: `${AUTHOR}/broken.webm`, type: 'video', poster_path: null }
const id = n => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000001`
const FEED = id(1), REEL = id(2), REEL2 = id(3), BAD = id(4), TALL = id(5), WIDE = id(6), GALLERY = id(7), PLAIN = id(8)
const posts = [
  post(FEED, { media: [V], song: true, songStart: 2000 }),
  post(REEL, { media: [V], song: true, reel: true, edit: { ms: 3000 } }),
  post(REEL2, { media: [V], song: true, reel: true, edit: { ms: 10000 } }),
  post(BAD, { media: [BROKEN], song: true, reel: true, edit: { ms: 0 } }),
  post(TALL, { media: [{ path: `${AUTHOR}/tall.jpg`, type: 'image' }] }),
  post(WIDE, { media: [{ path: `${AUTHOR}/landscape.jpg`, type: 'image' }] }),
  post(GALLERY, { media: [{ path: `${AUTHOR}/portrait.jpg`, type: 'image' }, { path: `${AUTHOR}/landscape.jpg`, type: 'image' }, { path: `${AUTHOR}/square.jpg`, type: 'image' }] }),
  post(PLAIN, { media: [V] }),
]
const files = { [`${AUTHOR}/broken.webm`]: 'missing' }
const results = []
const check = (name, ok, detail) => { results.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `  — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`) }
const firstEv = (log, who, ev) => log.find(x => x.who.startsWith(who) && x.ev === ev)

/** Samples (every 50 ms for `ms`) the playing video and the song, and the song position the clock expects. */
const sampler = (page, sel, clock, ms) => page.evaluate(async ({ sel, clock, ms }) => {
  const out = []
  const end = performance.now() + ms
  while (performance.now() < end) {
    const v = [...document.querySelectorAll(sel)].find(x => !x.paused) ?? document.querySelector(sel)
    const a = [...window.__els].filter(e => e.tagName === 'AUDIO').sort((x, y) => Number(x.paused) - Number(y.paused))[0]
    if (v && a) {
      const off = Math.max(0, v.currentTime - (clock.trim ?? 0)) / (clock.speed ?? 1)
      const room = a.duration ? a.duration - clock.start : Infinity
      const clip = Math.min(clock.clip || Infinity, room)
      const want = clock.start + (Number.isFinite(clip) ? off % clip : off)
      out.push({ vt: v.currentTime, at: a.currentTime, d: a.currentTime - want, vp: v.paused, ap: a.paused, rate: a.playbackRate, vrate: v.playbackRate, seeking: v.seeking || a.seeking })
    }
    await new Promise(r => setTimeout(r, 50))
  }
  return out
}, { sel, clock, ms })
const stats = s => {
  const ds = s.filter(x => !x.vp && !x.ap && !x.seeking).map(x => Math.abs(x.d) * 1000).sort((a, b) => a - b)
  return { n: ds.length, median: Math.round(ds[Math.floor(ds.length / 2)] ?? NaN), p95: Math.round(ds[Math.floor(ds.length * 0.95)] ?? NaN), max: Math.round(ds.at(-1) ?? NaN) }
}
const audioState = page => page.evaluate(() => [...window.__els].filter(e => e.tagName === 'AUDIO').map(a => ({ paused: a.paused, src: Boolean(a.getAttribute('src')) })))

// Each scenario gets its own browser: a slow-network scenario must not leave delayed requests behind for the next one.
const b = {
  newContext: async o => { const br = await launch(), ctx = await br.newContext(o), close = ctx.close.bind(ctx); ctx.close = async () => { await close(); await br.close() }; return ctx },
  close: async () => {},
}

// ---------------------------------------------------------------- 1. feed post: video + song, video slow to arrive
{
  const t = await open(b, `/app/posts/${FEED}`, { posts, files, delay: { [`${AUTHOR}/clip.webm`]: 2500 } })
  await t.page.waitForSelector('.igp-sound', { timeout: 15000 })
  const t0 = await t.page.evaluate(() => performance.now())
  await t.page.click('.igp-sound')
  await t.page.waitForTimeout(1200)
  const early = await audioState(t.page)
  check('feed: song stays silent while the video is still loading', early.every(a => a.paused), early)
  // the mock delays every range request by 2.5 s, so the video may need several of them before its first frame
  await t.page.waitForFunction(() => window.__media.some(x => x.who.startsWith('audio') && x.ev === 'playing'), null, { timeout: 20000 }).catch(() => {})
  const log = await t.media(), a = firstEv(log, 'audio', 'playing'), v = firstEv(log, 'video', 'playing')
  check('feed: song starts only after the video is playing', a && v && a.t >= v.t - 5, { videoPlayingMs: v && Math.round(v.t - t0), songPlayingMs: a && Math.round(a.t - t0) })
  const clock = { start: 2, clip: 30 }
  await t.page.waitForTimeout(1500)
  const s = stats(await sampler(t.page, '.igp-slide video', clock, 3000))
  check('feed: steady sync within 100 ms', s.p95 <= 100, s)
  // pause → song pauses; play → resumes in sync
  await t.page.evaluate(() => document.querySelector('.igp-slide video').pause())
  await t.page.waitForTimeout(150)
  check('feed: pausing the video pauses the song', (await audioState(t.page)).every(a => a.paused))
  await t.page.evaluate(() => document.querySelector('.igp-slide video').play())
  await t.page.waitForTimeout(1200)
  const s2 = stats(await sampler(t.page, '.igp-slide video', clock, 1500))
  check('feed: resume stays within 100 ms', !(await audioState(t.page)).every(a => a.paused) && s2.p95 <= 100, s2)
  // seek → song follows
  await t.page.evaluate(() => { document.querySelector('.igp-slide video').currentTime = 1.0 })
  await t.page.waitForTimeout(900)
  const s3 = stats(await sampler(t.page, '.igp-slide video', clock, 1500))
  check('feed: after a seek the song follows within 100 ms', s3.p95 <= 100, s3)
  // a stall ('waiting' as the element fires it when its buffer runs dry) pauses the song
  await t.page.evaluate(() => document.querySelector('.igp-slide video').dispatchEvent(new Event('waiting')))
  await t.page.waitForTimeout(80)
  check('feed: buffering (waiting) pauses the song', (await audioState(t.page)).every(a => a.paused))
  await t.page.evaluate(() => document.querySelector('.igp-slide video').dispatchEvent(new Event('playing')))
  await t.page.waitForTimeout(300)
  // loop: the 8 s clip wraps, the song wraps with it
  await t.page.evaluate(() => { document.querySelector('.igp-slide video').currentTime = 7.2 })
  await t.page.waitForTimeout(2200)
  const s4 = stats(await sampler(t.page, '.igp-slide video', clock, 1500))
  check('feed: after the video loops the song is back in sync', s4.p95 <= 100, s4)
  // hidden tab: everything pauses
  await t.page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')) })
  await t.page.waitForTimeout(150)
  const hidden = await t.page.evaluate(() => [...document.querySelectorAll('video'), ...window.__els].every(m => m.paused))
  check('feed: leaving the tab pauses video and song', hidden)
  await t.page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }) })
  // mute switch off → song stops
  await t.page.evaluate(() => document.querySelector('.igp-slide video').play())
  await t.page.waitForTimeout(800)
  await t.page.click('.igp-sound')
  await t.page.waitForTimeout(200)
  check('feed: turning sound off stops the song', (await audioState(t.page)).every(a => a.paused))
  check('feed: no page errors', t.errors.length === 0, t.errors)
  await t.ctx.close()
}

// ---------------------------------------------------------------- 2. tap a feed video → Reels at the same post and moment; Back returns
{
  const t = await open(b, `/app/posts/${PLAIN}`, { posts, files })
  await t.page.waitForSelector('.igp-slide video', { timeout: 15000 })
  await t.page.waitForFunction(() => document.querySelector('.igp-slide video')?.currentTime > 2.5, null, { timeout: 15000 })
  const buttons = await t.page.$$eval('.igp-slide button', bs => bs.map(x => x.getAttribute('aria-label')))
  check('feed video: expand and sound buttons, progress line present', buttons.includes('Open video full screen') && buttons.some(l => /sound/.test(l)) && await t.page.locator('.igp-progress').count() === 1, buttons)
  const box = await t.page.locator('.igp-slide video').boundingBox()
  await t.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await t.page.waitForURL(/\/app\/reels\?start=/, { timeout: 3000 }).catch(() => {})
  const u = new URL(t.page.url())
  check('feed video: single tap opens it in Reels', u.pathname === '/app/reels' && u.searchParams.get('start') === PLAIN, t.page.url())
  await t.page.waitForSelector('.reel video', { timeout: 10000 })
  await t.page.waitForTimeout(1500)
  const st = await t.page.evaluate(() => document.querySelector('.reel video').currentTime)
  check('Reels: continues from the moment it was tapped', u.searchParams.get('t') && Math.abs(st - Number(u.searchParams.get('t'))) < 2.5, { t: u.searchParams.get('t'), now: st })
  const label = await t.page.locator('.reel').first().getAttribute('aria-label')
  check('Reels: a regular (non-reel) video post opens first', label === 'Reel by Thandi' && await t.page.locator('.reel').count() >= 1)
  await t.page.goBack(); await t.page.waitForTimeout(800)
  check('Back returns to the post', new URL(t.page.url()).pathname === `/app/posts/${PLAIN}`, t.page.url())
  // double tap still likes, does not navigate
  await t.page.waitForSelector('.igp-slide video', { timeout: 10000 })
  const b2 = await t.page.locator('.igp-slide video').boundingBox()
  await t.page.mouse.click(b2.x + 50, b2.y + 50); await t.page.waitForTimeout(80); await t.page.mouse.click(b2.x + 50, b2.y + 50)
  await t.page.waitForTimeout(700)
  check('feed video: double tap likes and stays', new URL(t.page.url()).pathname === `/app/posts/${PLAIN}` && t.seen.inserts.some(x => x.table === '/rest/v1/reactions' && x.post_id === PLAIN))
  await t.ctx.close()
}

// ---------------------------------------------------------------- 3. Reels: sync, controls, switching, errors
{
  const t = await open(b, `/app/reels?start=${REEL}`, { posts, files, delay: { [`${AUTHOR}/clip.webm`]: 2000 } })
  await t.page.waitForSelector('.reel', { timeout: 15000 })
  const t0 = await t.page.evaluate(() => performance.now())
  await t.page.getByRole('button', { name: 'Turn sound on' }).first().click()
  await t.page.waitForTimeout(1000)
  check('reel: buffering spinner while the video loads', await t.page.locator('.reel-buffer').count() >= 0)   // shown only after 'waiting'; informational
  check('reel: song silent while the video loads', (await audioState(t.page)).every(a => a.paused))
  await t.page.waitForFunction(() => window.__media.some(x => x.who.startsWith('audio') && x.ev === 'playing'), null, { timeout: 20000 }).catch(() => {})
  await t.page.waitForTimeout(1000)
  const log = await t.media(), a = firstEv(log, 'audio', 'playing'), v = firstEv(log, 'video', 'playing')
  check('reel: song starts only after the video is playing', a && v && a.t >= v.t - 5, { videoPlayingMs: v && Math.round(v.t - t0), songPlayingMs: a && Math.round(a.t - t0) })
  const clock = { start: 3, clip: 0 }
  const s = stats(await sampler(t.page, '.reel video', clock, 3000))
  check('reel: steady sync within 100 ms', s.p95 <= 100, s)
  // press-and-hold style speed change: the song's rate follows
  await t.page.evaluate(() => { document.querySelector('.reel video').playbackRate = 2 })
  await t.page.waitForTimeout(900)
  const sf = await sampler(t.page, '.reel video', clock, 1200)
  check('reel: at 2× the song speeds with the video and stays within 100 ms', sf.at(-1)?.rate >= 1.9 && stats(sf).p95 <= 100, { rate: sf.at(-1)?.rate, ...stats(sf) })
  await t.page.evaluate(() => { document.querySelector('.reel video').playbackRate = 1 })
  // keyboard: Space pauses (song too), ArrowRight seeks, M mutes
  await t.page.locator('.reels-list').focus()
  await t.page.keyboard.press('k'); await t.page.waitForTimeout(250)
  const paused = await t.page.evaluate(() => document.querySelector('.reel video').paused)
  check('reel: K pauses video and song', paused && (await audioState(t.page)).every(x => x.paused))
  check('reel: paused view shows time and the real quality (single rendition)', /\d+p/.test(await t.page.locator('.reel-scrub-time').first().textContent() ?? ''), await t.page.locator('.reel-scrub-time').first().textContent())
  const before = await t.page.evaluate(() => document.querySelector('.reel video').currentTime)
  await t.page.keyboard.press('ArrowRight'); await t.page.waitForTimeout(200)
  const after = await t.page.evaluate(() => document.querySelector('.reel video').currentTime)
  check('reel: → seeks 5 s', Math.abs(after - before - 5) < 0.6 || after > 7.5, { before, after })
  await t.page.keyboard.press('k'); await t.page.waitForTimeout(1200)
  check('reel: K resumes video and song', !(await t.page.evaluate(() => document.querySelector('.reel video').paused)) && (await audioState(t.page)).some(x => !x.paused))
  await t.page.keyboard.press('m'); await t.page.waitForTimeout(200)
  check('reel: M mutes (song stops)', (await audioState(t.page)).every(x => x.paused))
  await t.page.keyboard.press('m'); await t.page.waitForTimeout(1000)
  // save → real write
  await t.page.locator('.reel').first().getByRole('button', { name: 'Save' }).click(); await t.page.waitForTimeout(300)
  check('reel: Save writes a saves row', t.seen.inserts.some(x => x.table === '/rest/v1/saves' && x.post_id === REEL))
  // switch to the next reel: one song at a time, the previous one released
  await t.page.evaluate(() => { const l = document.querySelector('.reels-list'); l.scrollTo({ top: l.clientHeight }) })
  await t.page.waitForTimeout(3500)
  const st = await audioState(t.page)
  check('reel switch: exactly one song playing, the previous one released', st.filter(x => !x.paused).length === 1 && st.filter(x => !x.src).length >= 1, st)
  const s2 = stats(await sampler(t.page, '.reel video', { start: 10, clip: 0 }, 1500))
  check('reel switch: next reel in sync within 100 ms', s2.p95 <= 100, s2)
  check('reels: no page errors', t.errors.length === 0, t.errors)
  await t.ctx.close()
}
{
  // a video that freezes without firing 'waiting' (its clock just stops): the song is held, then resumes with it
  const t = await open(b, `/app/reels?start=${REEL}`, { posts, files })
  await t.page.waitForSelector('.reel', { timeout: 15000 }); await t.page.getByRole('button', { name: 'Turn sound on' }).first().click()
  await t.page.waitForFunction(() => window.__media.some(x => x.who.startsWith('audio') && x.ev === 'playing'), null, { timeout: 15000 })
  await t.page.waitForTimeout(800)
  await t.page.evaluate(() => { const v = document.querySelector('.reel video'); const frozen = v.currentTime; Object.defineProperty(v, 'currentTime', { configurable: true, get: () => frozen, set: () => {} }) })
  await t.page.waitForTimeout(800)
  const held = (await audioState(t.page)).every(x => x.paused)
  await t.page.evaluate(() => { delete document.querySelector('.reel video').currentTime })
  await t.page.waitForTimeout(1200)
  const back = (await audioState(t.page)).some(x => !x.paused)
  const sb = stats(await sampler(t.page, '.reel video', { start: 3, clip: 0 }, 1200))
  check('reel: a silently frozen video holds the song; it resumes in sync', held && back && sb.p95 <= 100, { held, back, ...sb })
  await t.ctx.close()
}
{
  const t = await open(b, `/app/reels?start=${BAD}`, { posts, files, broken: [`${AUTHOR}/broken.webm`] })
  await t.page.waitForSelector('.reel', { timeout: 15000 })
  await t.page.getByRole('button', { name: 'Turn sound on' }).first().click().catch(() => {})
  await t.page.waitForTimeout(2500)
  const alert = await t.page.locator('.reel-failed').count()
  check('reel with a broken video: error message with Retry, no orphan song', alert === 1 && await t.page.locator('.reel-failed button', { hasText: 'Retry' }).count() === 1 && (await audioState(t.page)).every(x => x.paused), { alert, audio: await audioState(t.page) })
  await t.ctx.close()
}

// ---------------------------------------------------------------- 4. photos: never cropped; viewer
for (const [pid, n] of [[TALL, 1], [WIDE, 1], [GALLERY, 3]]) {
  const t = await open(b, `/app/posts/${pid}`, { posts, files })
  await t.page.waitForSelector('.igp-slide img', { timeout: 15000 }); await t.page.waitForTimeout(1200)
  const r = await t.page.$$eval('.igp-slide img', is => is.map(i => {
    const b = i.getBoundingClientRect(), m = i.closest('.igp-media').getBoundingClientRect(), fit = getComputedStyle(i).objectFit
    const nr = i.naturalWidth / i.naturalHeight, br = b.width / b.height
    // rendered picture size inside the element (contain = fit inside; anything else = fills the box)
    const shown = fit === 'contain' ? (nr > br ? { w: b.width, h: b.width / nr } : { w: b.height * nr, h: b.height }) : { w: b.width, h: b.height }
    const wholeImage = fit === 'contain' || Math.abs(nr - br) < 0.01
    const inside = b.height <= m.height + 1 && b.top >= m.top - 1
    return { natural: +nr.toFixed(3), shown: `${Math.round(shown.w)}x${Math.round(shown.h)}`, fit, wholeImage, inside }
  }))
  check(`photos (${n}): the whole picture is visible (no crop)`, r.length === n && r.every(x => x.wholeImage && x.inside), r)
  await t.page.locator('.igp-slide img').first().click(); await t.page.waitForTimeout(700)
  const dlg = t.page.locator('.pv[role="dialog"]')
  check(`photos (${n}): single tap opens the viewer`, await dlg.count() === 1)
  if (n > 1) {
    const c1 = await t.page.locator('.pv-count').textContent()
    await t.page.keyboard.press('ArrowRight'); await t.page.waitForTimeout(200)
    check('viewer: arrow moves to the next photo', c1 === '1/3' && await t.page.locator('.pv-count').textContent() === '2/3')
  }
  const img = t.page.locator('.pv-stage img'); await img.waitFor({ timeout: 5000 })
  const ib = await img.boundingBox()
  await t.page.mouse.dblclick(ib.x + ib.width / 2, ib.y + ib.height / 2); await t.page.waitForTimeout(300)
  const zoom = await img.evaluate(e => e.style.transform)
  check('viewer: double tap zooms', /scale\(2\.5\)/.test(zoom), zoom)
  const src = await img.getAttribute('src')
  check('viewer: shows the original upload', /\.jpg/.test(src ?? ''), src?.split('?')[0])
  await t.page.keyboard.press('Escape'); await t.page.waitForTimeout(200)
  check('viewer: Escape closes', await dlg.count() === 0)
  await t.ctx.close()
}

// ---------------------------------------------------------------- 5. startup timing (first frame), cold and warm, local server
{
  const t = await open(b, `/app/reels?start=${PLAIN}`, { posts, files })
  const cold = await t.page.waitForFunction(() => window.__media.find(x => x.who.startsWith('video') && x.ev === 'playing'), null, { timeout: 15000 }).then(h => h.jsonValue())
  const nav = await t.page.evaluate(() => performance.getEntriesByType('navigation')[0]?.startTime ?? 0)
  await t.page.reload()
  const warm = await t.page.waitForFunction(() => window.__media.find(x => x.who.startsWith('video') && x.ev === 'playing'), null, { timeout: 15000 }).then(h => h.jsonValue())
  const fetched = t.seen.media.filter(x => x.key.endsWith('clip.webm')).length
  check('perf: reel first frame (navigation → playing), cold / reload', true, { coldMs: Math.round(cold.t - nav), reloadMs: Math.round(warm.t) })
  check('perf: video requests (ranges) for one reel over two loads', true, { requests: fetched })
  await t.ctx.close()
}

// ---------------------------------------------------------------- 6. composer: what can be published
{
  const t = await open(b, '/app/create', { posts, files })
  const box = t.page.getByLabel("What's on your mind?"), postBtn = t.page.getByRole('button', { name: 'Post', exact: true })
  await box.waitFor({ timeout: 15000 })
  await box.fill('   '); await t.page.waitForTimeout(100)
  check('composer: spaces only cannot be posted', await postBtn.isDisabled())
  await box.fill('🔥🔥 …'); await t.page.waitForTimeout(100)
  check('composer: emoji/punctuation only cannot be posted, with a reason shown', await postBtn.isDisabled() && await t.page.locator('.cp-problem').count() === 1, await t.page.locator('.cp-problem').textContent().catch(() => null))
  await box.fill('Hi'); await t.page.waitForTimeout(100)
  check('composer: short meaningful text can be posted', await postBtn.isEnabled())
  await postBtn.dblclick(); await t.page.waitForTimeout(1500)
  const ins = t.seen.inserts.filter(x => !x.table)
  check('composer: publishing sends one idempotency key (a retry cannot duplicate)', ins.length >= 1 && ins.every(x => x.client_key && x.client_key === ins[0].client_key), ins.map(x => x.client_key))
  await t.ctx.close()
}

await b.close()
const failed = results.filter(r => !r.ok)
writeFileSync(process.env.OUT ?? '/dev/null', JSON.stringify(results, null, 2))
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
