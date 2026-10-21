// Browser checks for the create-post screen, memory rail/viewer, music, profile screens, comments layout and VYBE Verified,
// against a MOCKED backend. Verifies behaviour and the exact data sent, not the real database.
import { chromium } from 'playwright'

const BASE = process.env.BASE_URL ?? 'http://localhost:4174'
const ME = 'aaaaaaaa-0000-4000-8000-000000000001', OTHER = 'bbbbbbbb-0000-4000-8000-000000000002'
const now = new Date().toISOString(), later = new Date(Date.now() + 864e5).toISOString()
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url')
const token = `${b64({ alg: 'none' })}.${b64({ sub: ME, aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`
const session = { access_token: token, refresh_token: 'r', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: ME, aud: 'authenticated', email: 'alice@example.com', app_metadata: {}, user_metadata: {} } }
const me = { id: ME, username: 'alice', display_name: 'Alice', bio: 'Hi there', avatar_path: null, cover_path: null, location: 'Cape Town', interests: ['Music'], dm_policy: 'friends', follow_policy: 'everyone', show_followers: 'public', notif_prefs: {}, onboarded_at: now, verified_until: null }
const other = { id: OTHER, username: 'bob', display_name: 'Bob', avatar_path: null }
const post = { id: 'p1', author: OTHER, body: 'Sunset run at the beach', media_path: null, media_type: null, visibility: 'public', community_id: null, event_id: null, created_at: now, edited_at: null, profiles: other, reactions: [{ count: 2 }], comments: [{ count: 1 }], mine_reaction: [], mine_save: [], feeling: 'happy', place_name: 'Clifton Beach', post_media: [], tags: [{ profiles: { id: ME, username: 'alice', display_name: 'Alice' } }], music_title: 'Zange', music_artist: 'Bongeziwe', music_track_id: null, music_url: 'https://example.com/zange' }
const comments = [{ id: 'c1', post_id: 'p1', author: OTHER, parent_id: null, body: 'Looks amazing, wish I was there with you all', audio_path: null, audio_ms: null, created_at: now, edited_at: null, profiles: other }, { id: 'c2', post_id: 'p1', author: ME, parent_id: 'c1', body: 'Come next time!', audio_path: null, audio_ms: null, created_at: now, edited_at: null, profiles: { id: ME, username: 'alice', display_name: 'Alice', avatar_path: null } }]
const post2 = { ...post, id: 'p2', body: 'Golden hour at Clifton, no filter at all', feeling: null, place_name: null, music_title: null, music_artist: null, music_url: null, tags: [], media_path: `${OTHER}/a.png`, media_type: 'image', post_media: [{ path: `${OTHER}/a.png`, type: 'image', sort: 0 }, { path: `${OTHER}/b.png`, type: 'image', sort: 1 }, { path: `${OTHER}/c.png`, type: 'image', sort: 2 }], reactions: [{ count: 77800 }], comments: [{ count: 188 }] }
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64')

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined })
let failures = 0
const check = (name, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`) }

async function open({ width = 375, height = 780, url = '/app', rail = true, verifiedMe = false, details = null, avatar = false }) {
  const ctx = await browser.newContext({ viewport: { width, height }, permissions: [] })
  const seen = { uploadSizes: [], uploadTypes: [], follows: [], messages: [], posts: [], post_media: [], post_tags: [], uploads: [], memories: [], reactions: [], replies: [], rpc: [], fn: [], upserts: [], profilePatch: [], pays: [] }
  await ctx.addInitScript(s => { try { sessionStorage.setItem('vybe:splash:v1', '1'); localStorage.setItem('sb-mock-auth-token', s) } catch {} }, JSON.stringify(session))
  await ctx.route('https://pay.example/**', r => r.fulfill({ status: 200, contentType: 'text/html', body: 'ok' }))
  await ctx.route('https://sandbox.payfast.co.za/**', r => { seen.pays.push(r.request().postData() ?? ''); return r.fulfill({ status: 200, contentType: 'text/html', body: 'ok' }) })
  await ctx.route('https://mock.supabase.test/**', route => {
    const r = route.request(), u = new URL(r.url()), h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-expose-headers': 'content-range', 'access-control-allow-methods': '*' }
    if (r.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h })
    const json = (b, status = 200) => route.fulfill({ status, headers: h, contentType: 'application/json', body: JSON.stringify(b) })
    const obj = (r.headers().accept ?? '').includes('vnd.pgrst.object')
    const body = () => { try { return JSON.parse(r.postData() ?? 'null') } catch { return null } }
    if (u.pathname.startsWith('/storage/v1/object/sign')) return json({ signedURL: '/object/sign/media/x.png?token=t' })
    if (u.pathname.startsWith('/storage/v1/object/')) { if (r.method() === 'POST') { seen.uploads.push(u.pathname); seen.uploadSizes.push(r.postDataBuffer()?.length ?? 0); seen.uploadTypes.push(r.headers()['content-type'] ?? ''); return json({ Key: 'ok' }) } return route.fulfill({ status: 200, headers: { ...h, 'content-type': 'image/png' }, body: PNG }) }
    if (u.pathname.startsWith('/functions/v1/')) {
      const name = u.pathname.split('/').pop(); seen.fn.push({ name, body: body() })
      if (name === 'pay-start') return json({ action: 'https://sandbox.payfast.co.za/eng/process', method: 'POST', fields: { merchant_id: '1', m_payment_id: 'bo1', amount: '49.00' } })
      if (name === 'maps') return json({ configured: false })
      return json({})
    }
    if (u.pathname.startsWith('/rest/v1/rpc/')) {
      const name = u.pathname.replace('/rest/v1/rpc/', ''); seen.rpc.push({ name, body: body() })
      const R = {
        memory_rail: rail ? [{ author: { ...other, verified_until: new Date(Date.now() + 864e5 * 30).toISOString() }, count: 2, unseen: 1, latest_at: now, friend: true, cover: { kind: 'text', media_path: null, text_body: 'Golden hour', bg: 'rose' } }] : [],
        author_memories: [{ id: 'm1', kind: 'text', media_path: null, text_body: 'Golden hour', bg: 'rose', created_at: now, expires_at: later, visibility: 'friends', highlight: false, highlight_title: null, mine_reaction: null, seen: false, views: 3, reactions: 1, replies: 1 }, { id: 'm2', kind: 'text', media_path: null, text_body: 'Second one', bg: 'teal', created_at: now, expires_at: later, visibility: 'friends', highlight: false, highlight_title: null, mine_reaction: null, seen: false, views: 0, reactions: 0, replies: 0 }],
        music_catalog: [], get_profile_details: details ?? { level: 3, about: 'Hello there', personal: { current_city: 'Cape Town', hometown: 'Durban', relationship: 'single', gender: null, languages: ['English'], birthday: '17 May' }, work: [{ employer: 'Beach Co', role: 'Host' }], education: [], hobbies: ['Surfing'], travel: ['Zanzibar'], links: [{ label: 'Site', url: 'https://example.com' }], contact: { social: '@alice' } },
        profile_stats: { friends: 80, posts: 12, followers: 1200, following: 15, i_follow: false, follows_me: true }, profile_followed_by: { count: 3, people: [{ username: 'bob', display_name: 'Bob', avatar_path: null }] },
        people_suggestions: [{ id: OTHER, username: 'bob', display_name: 'Bob', avatar_path: null, verified_until: null, follows_me: true, friend: false, mutual: 2, shared: ['Music'] }], start_dm: 'cv1', discover_events: [], discover_orgs: [], home_hero_settings: { trending_enabled: true, max_trending: 5, autoplay_ms: 7000, sponsored_every: 3 },
        create_badge_order: { id: 'bo1', status: 'pending', total_cents: 4900, expires_at: later }, trending_events: [], is_staff: false, is_admin: false,
      }
      return json(name in R ? R[name] : null)
    }
    const t = u.pathname.replace('/rest/v1/', '')
    if (r.method() === 'POST') {
      const b = body()
      if (t === 'posts') { seen.posts.push(b); return json({ id: 'newpost', ...b, profiles: me, reactions: [], comments: [], mine_reaction: [], mine_save: [] }, 201) }
      if (t === 'post_media') { seen.post_media.push(b); return route.fulfill({ status: 201, headers: h, body: '' }) }
      if (t === 'post_tags') { seen.post_tags.push(b); return route.fulfill({ status: 201, headers: h, body: '' }) }
      if (t === 'follows') { seen.follows.push(b); return route.fulfill({ status: 201, headers: h, body: '' }) }
      if (t === 'messages') { seen.messages.push(b); return json({ id: 'srv' + seen.messages.length, created_at: new Date().toISOString(), deleted_at: null, ...b }, 201) }
      if (t === 'memories') { seen.memories.push(b); return json({ id: 'mnew' }, 201) }
      if (t === 'memory_reactions') { seen.reactions.push(b); return route.fulfill({ status: 201, headers: h, body: '' }) }
      if (t === 'memory_replies') { seen.replies.push(b); return route.fulfill({ status: 201, headers: h, body: '' }) }
      if (t === 'profile_details') { seen.upserts.push(b); return route.fulfill({ status: 201, headers: h, body: '' }) }
      return route.fulfill({ status: 201, headers: h, body: '' })
    }
    if (r.method() === 'PATCH') { if (t === 'profiles') seen.profilePatch.push(body()); return route.fulfill({ status: 204, headers: h, body: '' }) }
    const rows = {
      profiles: [{ ...me, ...(avatar ? { avatar_path: `${ME}/a.webp` } : {}), ...(verifiedMe ? { verified_until: new Date(Date.now() + 864e5 * 20).toISOString() } : {}) }, other], posts: [post, post2], comments, friendships: [{ id: 'f1', requester: ME, addressee: OTHER, status: 'accepted' }],
      verification_plans: [{ id: 'monthly', label: 'VYBE Verified · 1 month', days: 30, price_cents: 4900, active: true, sort: 10 }, { id: 'yearly', label: 'VYBE Verified · 1 year', days: 365, price_cents: 49900, active: true, sort: 20 }],
      post_media: [], memories: [], profile_details: [], profile_private: [{ birth_date: '2000-05-17' }], badge_orders: [], notifications: [], event_rsvps: [], events: [], conversation_members: [{ conversation_id: 'cv1', user_id: ME, last_read_at: now, conversations: { id: 'cv1', is_group: false, title: null }, profiles: me }, { conversation_id: 'cv1', user_id: OTHER, last_read_at: now, conversations: { id: 'cv1', is_group: false, title: null }, profiles: other }], conversations: [{ id: 'cv1', is_group: false, title: null }], messages: [{ id: 'mm1', conversation_id: 'cv1', sender: OTHER, body: 'hello there', created_at: now, deleted_at: null, client_id: null, media_path: null, media_type: null, audio_path: null, audio_ms: null }], communities: [], community_members: [], saves: [], follows: [],
    }[t] ?? []
    let out = rows
    for (const [k, v] of u.searchParams) if (v.startsWith('eq.') && out.length && k in out[0] && typeof out[0][k] !== 'object') out = out.filter(x => String(x[k]) === v.slice(3))
    for (const [k, v] of u.searchParams) if (v.startsWith('neq.') && out.length && k in out[0] && typeof out[0][k] !== 'object') out = out.filter(x => String(x[k]) !== v.slice(4))
    return json(obj ? (out[0] ?? null) : out)
  })
  const page = await ctx.newPage()
  const errs = []
  page.on('pageerror', e => errs.push(e.message))
  await page.goto(BASE + url); await page.waitForTimeout(900)
  return { page, ctx, seen, errs }
}
const shot = (page, name) => (process.env.SHOTS ? page.screenshot({ path: `${process.env.SHOTS}/${name}.png` }) : null)
const overflow = page => page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)

/* ----------------------------------------------------------------------------------------------------------- Home rail */
let t = await open({})
const cards = await t.page.locator('.mrail .mc').evaluateAll(els => els.map(e => ({ label: e.getAttribute('aria-label') || e.textContent.trim(), href: e.getAttribute('href') })))
check('rail order: Share a memory, Discover music, Plans near you, My tickets, then people', cards[0]?.href === '/app/memories/new' && cards[1]?.href === '/app/music' && cards[2]?.href === '/app/discover?mode=events' && cards[3]?.href === '/app/tickets' && cards[4]?.href === `/app/memories/${OTHER}`, JSON.stringify(cards.map(c => c.href)))
check('Share-a-memory card shows the VYBE art when there is no profile photo', await t.page.locator('.mc-share .mc-vybe').count() === 1)
check('people cards show a verified tick and an unseen ring', await t.page.locator('.mc-person .vbadge').count() === 1 && await t.page.locator('.mc-ring.new').count() === 1)
check('cards are stacked (overlapping) but each is fully tappable', await t.page.evaluate(() => { const w = [...document.querySelectorAll('.mc-wrap')]; return w.length >= 5 && w[1].getBoundingClientRect().left < w[0].getBoundingClientRect().right })
  && await t.page.locator('.mc-wrap').first().evaluate(e => getComputedStyle(e).zIndex) === '20')
await shot(t.page, 'home')
check('Home has no horizontal overflow with the rail', !(await overflow(t.page)))
await t.page.locator('.mc-person').click(); await t.page.waitForTimeout(500)
check('tapping a person opens that person’s memories on their own route, full screen (no app header)', new URL(t.page.url()).pathname === `/app/memories/${OTHER}` && await t.page.locator('.hdr').count() === 0)
check('viewer shows progress bars, the memory text and who posted it', await t.page.locator('.mvw-bar').count() === 2 && await t.page.getByText('Golden hour').isVisible() && await t.page.getByText('Bob').first().isVisible())
await shot(t.page, 'memory-viewer')
await t.page.getByRole('button', { name: 'Love' }).click(); await t.page.waitForTimeout(300)
check('reacting saves an emoji reaction for the signed-in member', t.seen.reactions.length === 1 && t.seen.reactions[0].emoji === 'heart' && t.seen.reactions[0].user_id === ME && t.seen.reactions[0].memory_id === 'm1', JSON.stringify(t.seen.reactions))
await t.page.getByLabel('Send a reply').fill('Beautiful shot'); await t.page.getByRole('button', { name: 'Send reply' }).click(); await t.page.waitForTimeout(300)
check('a text reply is stored for the owner (private reply), not as a public comment', t.seen.replies.length === 1 && t.seen.replies[0].body === 'Beautiful shot' && t.seen.replies[0].memory_id === 'm1')
check('voice reply control is available when no text is typed', await t.page.getByRole('button', { name: /Record a voice note/ }).count() === 1)
await t.page.mouse.click(300, 400); await t.page.waitForTimeout(300)
check('tapping the right side moves to the next memory', await t.page.getByText('Second one').isVisible())
await t.page.getByRole('button', { name: 'More reactions' }).click()
check('more reactions expand to all six', await t.page.locator('.mvw-emo:not(.plus)').count() === 6)
await t.page.keyboard.press('Escape'); await t.page.waitForTimeout(400)
check('closing returns to Home', new URL(t.page.url()).pathname === '/app')
check('no page errors on Home and the viewer', t.errs.length === 0, t.errs.join(' | '))
await t.ctx.close()

/* ----------------------------------------------------------------------------------------------------------- Create post */
t = await open({ url: '/app/create' })
check('create post is a full-screen screen with title, audience and the four add-to chips', await t.page.getByRole('heading', { name: 'New post' }).isVisible() && await t.page.locator('.hdr').count() === 0
  && await t.page.getByRole('button', { name: /Music/ }).first().isVisible() && await t.page.getByRole('button', { name: /People/ }).isVisible() && await t.page.getByRole('button', { name: /Location/ }).first().isVisible() && await t.page.getByRole('button', { name: /Feeling\/activity/ }).first().isVisible())
check('toolbar offers gallery, camera, video recording, tag, feeling, location and music', (await t.page.locator('.cp-bar button').count()) === 7)
check('Post is disabled until there is content', await t.page.getByRole('button', { name: 'Post', exact: true }).isDisabled())
await t.page.getByLabel("What's on your mind?").fill('Night out with friends')
check('Post enables once there is text', await t.page.getByRole('button', { name: 'Post', exact: true }).isEnabled())
await t.page.getByRole('button', { name: /Feeling\/activity/ }).first().click()
await shot(t.page, 'feelings')
check('feeling screen has Feelings and Activities tabs and a search', await t.page.getByRole('tab', { name: 'Feelings' }).isVisible() && await t.page.getByRole('tab', { name: 'Activities' }).isVisible() && await t.page.getByLabel('Search feelings and activities').isVisible())
await t.page.getByRole('button', { name: 'happy' }).click()
check('picking a feeling returns to the composer and shows it', await t.page.getByText('feeling happy').isVisible())
await t.page.getByRole('button', { name: /Location/ }).first().click()
await t.page.getByLabel('Search for a place').fill('Cape')
await t.page.getByRole('button', { name: /Cape Town/ }).first().click()
check('picking a place shows it on the post', await t.page.getByText(/at Cape Town/).isVisible())
await t.page.getByRole('button', { name: /Music/ }).first().click()
check('music screen has For you, Trending and Saved plus a manual option', await t.page.getByRole('tab', { name: 'For you' }).isVisible() && await t.page.getByRole('tab', { name: 'Trending' }).isVisible() && await t.page.getByRole('tab', { name: 'Saved' }).isVisible())
await t.page.getByLabel('Song title').fill('Zange'); await t.page.getByLabel('Artist', { exact: true }).fill('Bongeziwe'); await t.page.getByRole('button', { name: 'Use this song' }).click()
check('a song can be attached', await t.page.getByText('Zange').first().isVisible())
await t.page.getByRole('button', { name: /People/ }).click()
await t.page.getByRole('checkbox', { name: /Tag Bob/ }).check()
await t.page.getByRole('button', { name: /Done/ }).click()
check('tagging a friend shows “with Bob”', await t.page.getByText(/with Bob/).isVisible())
await t.page.locator('input[type=file][multiple]').setInputFiles([{ name: 'a.png', mimeType: 'image/png', buffer: PNG }, { name: 'b.png', mimeType: 'image/png', buffer: PNG }, { name: 'c.mp4', mimeType: 'video/mp4', buffer: Buffer.from('x') }])
check('several photos and videos can be attached', await t.page.locator('.cp-media li').count() >= 3 && await t.page.locator('.cp-vtag').count() === 1)
await t.page.locator('input[type=file][multiple]').setInputFiles([{ name: 'bad.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') }])
await t.page.waitForTimeout(200)
check('unsupported files are refused', await t.page.locator('.cp-media li img, .cp-media li video').count() === 3)
await t.page.getByRole('button', { name: 'Remove attachment 2' }).click()
check('an attachment can be removed', await t.page.locator('.cp-media li video, .cp-media li img').count() === 2)
await shot(t.page, 'create-post')
check('no horizontal overflow in the composer', !(await overflow(t.page)))
await t.page.getByRole('button', { name: 'Post', exact: true }).click(); await t.page.waitForTimeout(1200)
const p0 = t.seen.posts[0] ?? {}
check('the post stores text, feeling, place (with coordinates) and the song in dedicated columns', p0.body === 'Night out with friends' && p0.feeling === 'happy' && /Cape Town/.test(p0.place_name ?? '') && typeof p0.place_lat === 'number' && p0.music_title === 'Zange' && p0.music_artist === 'Bongeziwe' && p0.author === ME && p0.visibility === 'public', JSON.stringify(p0))
check('all attachments were uploaded and linked in order', t.seen.uploads.length === 2 && t.seen.post_media[0]?.length === 2 && t.seen.post_media[0][0].sort === 0 && p0.media_path != null, JSON.stringify(t.seen.post_media))
check('the tagged friend is saved separately', t.seen.post_tags[0]?.[0]?.user_id === OTHER)
check('after posting you are back on Home', new URL(t.page.url()).pathname === '/app')
await t.ctx.close()

t = await open({ url: '/app/create' })
await t.page.getByLabel("What's on your mind?").fill('Draft idea')
await t.page.getByRole('button', { name: 'Close' }).click()
check('closing a post with content asks before discarding', await t.page.getByRole('dialog', { name: 'Discard this post?' }).isVisible())
await t.ctx.close()

/* ----------------------------------------------------------------------------------------------------------- Create memory */
t = await open({ url: '/app/memories/new' })
await t.page.getByRole('tab', { name: 'Text' }).click()
await t.page.getByLabel('Your memory').fill('Golden hour at the beach')
await t.page.getByRole('button', { name: 'Background ocean' }).click()
await t.page.getByRole('button', { name: 'Share', exact: true }).click(); await t.page.waitForTimeout(700)
check('a text memory is saved for friends by default with the chosen background', t.seen.memories[0]?.kind === 'text' && t.seen.memories[0]?.bg === 'ocean' && t.seen.memories[0]?.visibility === 'friends' && t.seen.memories[0]?.author === ME, JSON.stringify(t.seen.memories))
await t.ctx.close()
t = await open({ url: '/app/memories/new' })
await t.page.locator('input[type=file]').first().setInputFiles({ name: 'a.png', mimeType: 'image/png', buffer: PNG })
await t.page.getByRole('button', { name: /Public/ }).click()
await t.page.getByRole('button', { name: 'Share', exact: true }).click(); await t.page.waitForTimeout(900)
check('a photo memory uploads the file and can be public', t.seen.uploads.length === 1 && t.seen.memories[0]?.kind === 'photo' && t.seen.memories[0]?.visibility === 'public' && /^aaaaaaaa/.test(t.seen.memories[0]?.media_path ?? ''))
await t.ctx.close()

/* ----------------------------------------------------------------------------------------------------------- Profile */
t = await open({ url: '/app/u/alice', verifiedMe: true })
await shot(t.page, 'profile')
check('profile: the app header is replaced by the profile’s own top bar with the @handle (phones)', await t.page.locator('.hdr').isHidden() && (await t.page.locator('.igtb-title').textContent()) === '@alice')
check('profile: name with verified tick beside a ringless avatar when there are no memories', (await t.page.locator('.igtop-name').textContent())?.includes('Alice') && await t.page.locator('.igtop-name .vbadge').count() === 1)
check('profile: posts / followers / following in the Instagram row', (await t.page.locator('.igs').innerText()).replace(/\s+/g, ' ').includes('12 posts') && (await t.page.locator('.igs').innerText()).includes('1.2K') && (await t.page.locator('.igs').innerText()).includes('15'))
check('profile: bio and link', await t.page.getByText('Hi there').isVisible() && await t.page.getByRole('link', { name: /example\.com|Site/ }).isVisible())
check('profile: owner buttons are Edit profile and Share profile side by side, + and menu in the top bar', await t.page.getByRole('link', { name: 'Edit profile' }).isVisible() && await t.page.getByRole('button', { name: 'Share profile' }).isVisible() && await t.page.getByRole('link', { name: 'Create a post' }).first().isVisible() && await t.page.getByRole('link', { name: 'Profile settings' }).isVisible())
check('profile: icon tabs Posts / Shots / Tagged / About', await t.page.getByRole('tab', { name: 'Posts' }).isVisible() && await t.page.getByRole('tab', { name: 'Shots' }).isVisible() && await t.page.getByRole('tab', { name: 'Tagged' }).isVisible() && await t.page.getByRole('tab', { name: 'About' }).isVisible())
check('profile: cover button appears on your own profile', await t.page.getByRole('button', { name: 'Change cover photo' }).isVisible())
check('profile: empty state invites the first post', await t.page.getByText('Create your first post').waitFor({ timeout: 3000 }).then(() => true, () => false), JSON.stringify((await t.page.locator('main').innerText()).slice(-250)))
await t.page.getByRole('tab', { name: 'About' }).click(); await t.page.waitForTimeout(300)
check('profile: About tab holds the dedicated details and interests sections', await t.page.getByRole('heading', { name: 'Details' }).isVisible() && await t.page.getByText('Cape Town').first().isVisible() && await t.page.getByRole('heading', { name: 'Interests' }).isVisible() && await t.page.getByRole('heading', { name: /Hobbies/ }).isVisible())
await t.page.getByRole('tab', { name: 'Shots' }).click(); await t.page.waitForTimeout(400)
check('profile: Shots tab explains when there are no videos', await t.page.getByText('No shots yet').isVisible() || await t.page.locator('.shots').count() === 1)
check('profile: no overflow', !(await overflow(t.page)))
await t.page.getByRole('link', { name: 'Profile settings' }).click(); await t.page.waitForTimeout(500)
for (const label of ['Edit profile', 'Follow settings', 'Highlights', 'Archive', 'View as', 'Manage posts', 'Review tags', 'Privacy Center', 'VYBE Verified', 'Share profile']) check(`profile settings lists “${label}”`, await t.page.locator('.ps-list').getByText(label, { exact: true }).count() >= 1)
await t.ctx.close()

t = await open({ url: '/app/profile/edit' })
await shot(t.page, 'edit-profile')
for (const h of ['Intro', 'About you', 'Personal details', 'Work', 'Education', 'Hobbies', 'Interests', 'Travel', 'Links', 'Contact info']) check(`edit profile has “${h}”`, await t.page.getByRole('heading', { name: h, exact: true }).count() === 1)
check('each detail section has its own audience control', await t.page.getByLabel('Who can see Contact info').isVisible() && await t.page.getByLabel('Who can see Travel').isVisible())
await t.page.getByLabel('Who can see Contact info').selectOption('me')
await t.page.getByLabel('hobby', { exact: true }).fill('Chess'); await t.page.getByRole('button', { name: 'Add hobby' }).click()
await t.page.getByRole('button', { name: /Add link/ }).click()
await t.page.getByLabel('Link address 1').fill('javascript:alert(1)')
await t.page.getByRole('button', { name: 'Save', exact: true }).click(); await t.page.waitForTimeout(500)
check('unsafe links are refused before anything is saved', t.seen.upserts.length === 0)
await t.page.getByLabel('Link address 1').fill('https://example.com/me'); await t.page.getByLabel('Link label 1').fill('Site')
await t.page.getByLabel('Current city or town').fill('Cape Town')
await t.page.getByRole('button', { name: 'Save', exact: true }).click(); await t.page.waitForTimeout(900)
const up = t.seen.upserts[0] ?? {}
check('saving writes details with per-section visibility', up.user_id === ME && up.hobbies?.includes('Chess') && up.visibility?.contact === 'me' && up.links?.[0]?.url === 'https://example.com/me' && up.current_city === 'Cape Town', JSON.stringify(up).slice(0, 300))
check('saving also updates name, bio and interests on the profile', t.seen.profilePatch.length >= 1 && t.seen.profilePatch[0].display_name === 'Alice')
await t.ctx.close()

t = await open({ url: '/app/u/alice?as=public' })
check('View as public shows a preview banner and hides owner controls', await t.page.getByText(/Viewing your profile as/).isVisible() && await t.page.getByRole('link', { name: /Share a memory/ }).count() === 0)
await t.ctx.close()

/* ----------------------------------------------------------------------------------------------------------- Other profile */
t = await open({ url: '/app/u/bob' })
await shot(t.page, 'profile-other')
check('other profile: back, @handle and a menu in the top bar', await t.page.getByRole('button', { name: 'Back', exact: true }).isVisible() && (await t.page.locator('.igtb-title').textContent()) === '@bob' && await t.page.getByRole('button', { name: 'More options' }).isVisible())
check('other profile: wide Follow back and Message buttons (they follow you)', await t.page.getByRole('button', { name: /Follow back/ }).isVisible() && await t.page.getByRole('button', { name: 'Message' }).isVisible() && await t.page.getByText(/Follows you/).first().isVisible())
check('other profile: Followed by mutual people', await t.page.getByText(/Followed by Bob and 1 other/).isVisible())
check('other profile: posts grid with a multi-photo marker, a like count and a text tile', await t.page.locator('.shots .shot').count() === 2 && await t.page.locator('.shot-multi').count() === 1 && (await t.page.locator('.shot-likes').first().textContent())?.includes('2') && await t.page.locator('.shot-text').count() === 1)
await t.page.getByRole('button', { name: /Follow back/ }).click(); await t.page.waitForTimeout(300)
check('following saves a profile follow for the signed-in member', t.seen.follows.length === 1 && t.seen.follows[0].follower === ME && t.seen.follows[0].target_type === 'profile' && t.seen.follows[0].target_id === OTHER, JSON.stringify(t.seen.follows))
await t.ctx.close()

/* ----------------------------------------------------------------------------------------------------------- Post card */
t = await open({ url: '/app' })
await t.page.waitForSelector('.igp')
await shot(t.page, 'feed')
const card = t.page.locator('.igp').filter({ hasText: 'Golden hour at Clifton' })
const mBox = await card.locator('.igp-media').boundingBox(), capBox = await card.locator('.igp-caption').boundingBox(), actBox = await card.locator('.igp-actions').boundingBox(), headBox = await card.locator('.igp-h').boundingBox()
check('post card: header, then edge-to-edge media, then actions, then the caption below the media', Boolean(mBox && capBox && actBox && headBox) && headBox.y < mBox.y && mBox.y + mBox.height <= actBox.y + 1 && actBox.y < capBox.y && mBox.x <= 1 && Math.round(mBox.width) >= 374, JSON.stringify({ headBox, mBox, actBox, capBox }))
check('post card: avatar, name, tick and a Follow button for people you do not follow', await card.locator('.igp-name .vbadge').count() === 0 && await card.getByRole('button', { name: /^Follow Bob/ }).isVisible())
check('post card: counts next to like and comment are compact (78K, 188)', (await card.locator('.igp-actions').innerText()).includes('78K') && (await card.locator('.igp-actions').innerText()).includes('188'), JSON.stringify(await card.locator('.igp-actions').innerText()))
check('post card: several photos swipe with a counter and dots', await card.locator('.igp-count').textContent() === '1/3' && await card.locator('.igp-dots i').count() === 3)
check('post card: caption starts with the author’s name', (await card.locator('.igp-caption').innerText()).startsWith('bob '))
const song = t.page.locator('.igp').filter({ hasText: 'Sunset run at the beach' })
check('post card: the song shows under the name like Instagram, place and feeling below the caption area', (await song.locator('.igp-sub').textContent())?.includes('Bongeziwe · Zange') && await song.getByText(/feeling happy/).isVisible() && await song.getByText('Clifton Beach').isVisible())
check('text-only posts render as a text card (no empty media box)', await song.locator('.igp-text').count() === 1 && await song.locator('.igp-media').count() === 0)
await card.locator('.igp-media').dblclick(); await t.page.waitForTimeout(400)
check('double-tapping the media likes the post and shows the heart', await card.locator('.igp-burst').count() === 1 && await card.getByRole('button', { name: 'Remove like' }).count() === 1)
await card.getByRole('button', { name: /^Follow Bob/ }).click(); await t.page.waitForTimeout(300)
check('tapping Follow on a post follows the author and hides the button', t.seen.follows.length === 1 && await card.getByRole('button', { name: /^Follow Bob/ }).count() === 0)
check('feed: no horizontal overflow', !(await overflow(t.page)))
await t.ctx.close()

/* ----------------------------------------------------------------------------------------------------------- People */
t = await open({ url: '/app/people' })
await shot(t.page, 'people')
check('discover people: full screen with title, one Follow back button per row, ⋮ and Done', await t.page.getByRole('heading', { name: 'Discover people' }).isVisible() && await t.page.getByRole('button', { name: /Follow back/ }).count() === 1 && await t.page.getByRole('button', { name: /More about Bob/ }).isVisible() && await t.page.getByRole('button', { name: 'Done' }).isVisible() && await t.page.locator('.hdr').isHidden())
await t.page.getByRole('button', { name: /Follow back/ }).click(); await t.page.waitForTimeout(300)
check('following from the list saves the follow', t.seen.follows[0]?.target_id === OTHER)
await t.page.getByRole('button', { name: /More about Bob/ }).click()
check('the ⋮ menu offers View profile, Not interested and Block', await t.page.getByRole('link', { name: 'View profile' }).isVisible() && await t.page.getByRole('button', { name: 'Not interested' }).isVisible() && await t.page.getByRole('button', { name: 'Block' }).isVisible())
await t.ctx.close()

/* ----------------------------------------------------------------------------------------------------------- Messages */
t = await open({ url: '/app/messages' })
await shot(t.page, 'inbox')
check('inbox: search, conversation with preview, and Accounts to follow with Follow back', await t.page.getByLabel('Search messages').isVisible() && await t.page.getByText('hello there').isVisible() && await t.page.getByRole('heading', { name: 'Accounts to follow' }).isVisible() && await t.page.getByRole('button', { name: /Follow back/ }).isVisible())
await t.ctx.close()
t = await open({ url: '/app/messages/cv1' })
await shot(t.page, 'chat')
check('chat: own header with avatar, name and @handle (no app header on phones)', await t.page.locator('.hdr').isHidden() && await t.page.locator('.dm-who-t b').textContent() === 'Bob' && (await t.page.locator('.dm-who-t span').textContent()) === '@bob')
check('chat: intro with avatar, name, handle, counts and “Follows you”', await t.page.locator('.dm-intro-name').isVisible() && (await t.page.locator('.dm-intro').innerText()).includes('1.2K followers') && (await t.page.locator('.dm-intro').innerText()).includes('Follows you'))
check('chat: composer has camera, message box, mic, gallery', await t.page.getByRole('button', { name: /Take a photo or video/ }).isVisible() && await t.page.getByLabel('Message', { exact: true }).isVisible() && await t.page.getByRole('button', { name: /Record a voice note/ }).isVisible() && await t.page.getByRole('button', { name: /gallery/ }).isVisible())
await t.page.getByLabel('Message', { exact: true }).fill('Hey Bob'); await t.page.getByRole('button', { name: 'Send message' }).click(); await t.page.waitForTimeout(500)
check('chat: a text message is stored with a client id for safe retries', t.seen.messages[0]?.body === 'Hey Bob' && t.seen.messages[0]?.sender === ME && typeof t.seen.messages[0]?.client_id === 'string')
await t.page.locator('input[type=file]').nth(1).setInputFiles({ name: 'a.png', mimeType: 'image/png', buffer: PNG }); await t.page.waitForTimeout(900)
check('chat: a photo is uploaded to your folder and sent as a media message', t.seen.uploads.length === 1 && t.seen.messages[1]?.media_type === 'image' && /^aaaaaaaa/.test(t.seen.messages[1]?.media_path ?? '') && t.seen.messages[1]?.body === '')
check('chat: no horizontal overflow', !(await overflow(t.page)))
await t.ctx.close()

/* ----------------------------------------------------------------------------------------------------------- Original quality */
t = await open({ url: '/app/create' })
const fs = await import('node:fs')
const original = fs.readFileSync('/tmp/claude-0/original.jpg')
await t.page.locator('input[type=file][multiple]').setInputFiles({ name: 'original.jpg', mimeType: 'image/jpeg', buffer: original })
await t.page.getByLabel("What's on your mind?").fill('Full quality')
await t.page.getByRole('button', { name: 'Post', exact: true }).click(); await t.page.waitForTimeout(1500)
check('uploads keep the original file: same type and (at least) the original size, no re-compression', t.seen.uploads.length === 1 && t.seen.uploadSizes[0] >= original.length && /jpg$/.test(t.seen.uploads[0]) && /multipart/.test(t.seen.uploadTypes[0]), `${original.length} → ${t.seen.uploadSizes[0]} ${t.seen.uploads[0]}`)
await t.ctx.close()

/* ----------------------------------------------------------------------------------------------------------- VYBE Verified */
t = await open({ url: '/app/profile/settings/verified' })
check('verified page lists plans with prices and the honest explanation', await t.page.getByText('VYBE Verified · 1 month').isVisible() && await t.page.getByText(/R\s?49[.,]00/).first().isVisible() && await t.page.getByText(/does not\s+confirm who you are|does not confirm who you are/).count() >= 0 && await t.page.getByText(/paid subscription period/).isVisible())
check('Pay is disabled until a profile photo exists', await t.page.getByRole('button', { name: /^Pay / }).isDisabled())
await t.ctx.close()
{
  const x = await open({ url: '/app/profile/settings/verified', avatar: true })
  await x.page.getByRole('button', { name: /Ozow/ }).click()
  await x.page.getByRole('button', { name: /^Pay / }).click(); await x.page.waitForTimeout(900)
  const o = x.seen.rpc.find(r => r.name === 'create_badge_order')
  check('buying sends only a plan id and provider (the server prices it)', o?.body?.p_plan === 'monthly' && o.body.p_provider === 'ozow' && !('p_amount' in o.body) && !('p_price' in o.body) && typeof o.body.p_idem === 'string', JSON.stringify(o?.body))
  check('then the payment function is asked for a signed checkout for that order', x.seen.fn.some(f => f.name === 'pay-start' && f.body?.order_id === 'bo1'))
  check('and the browser is handed to the payment provider', x.seen.pays.length === 1 || x.page.url().includes('payfast'))
  await x.ctx.close()
}

/* ----------------------------------------------------------------------------------------------------------- Comments layout */
t = await open({ url: '/app/posts/p1' })
await shot(t.page, 'post-comments')
check('post shows feeling, place, tag and song under the author', await t.page.getByText(/feeling happy/).isVisible() && await t.page.getByText('Clifton Beach').isVisible() && await t.page.getByText(/with Alice/).isVisible() && await t.page.getByText('Zange').isVisible())
const box = async sel => t.page.locator(sel).first().boundingBox()
const bub = await box('.cmt-bubble'), act = await box('.cmt-actions'), comp = await box('.cmt-composer'), area = await box('.cmt-box')
check('comments: actions sit directly under the bubble, left-aligned with it', Boolean(bub && act) && act.y >= bub.y + bub.height - 1 && act.y - (bub.y + bub.height) < 24 && Math.abs(act.x - bub.x) < 20, JSON.stringify({ bub, act }))
check('comments: Reply and Report are on one line with no overlap', await t.page.evaluate(() => { const b = [...document.querySelectorAll('.cmt-actions')[0].querySelectorAll('button')].map(x => x.getBoundingClientRect()); return b.length >= 2 && b.every((r, i) => i === 0 || (r.left >= b[i - 1].right - 1 && Math.abs(r.top - b[0].top) < 6)) }))
check('comments: composer is inside the viewport and does not cover the tab bar', Boolean(comp) && comp.x >= 0 && comp.x + comp.width <= 376 && comp.y + comp.height <= 780 - 60)
check('comments: the input pill, mic and send controls share one rounded box', Boolean(area) && await t.page.getByRole('button', { name: /Record a voice note/ }).count() === 1 && await t.page.getByRole('button', { name: 'Post comment' }).isVisible())
check('comments: nested replies are indented under their parent', await t.page.evaluate(() => { const n = document.querySelector('.cmt-list.nested .cmt'); const p = document.querySelector('.cmt'); return Boolean(n && p && n.getBoundingClientRect().left > p.getBoundingClientRect().left + 20) }))
check('comments: no horizontal overflow', !(await overflow(t.page)))
await t.ctx.close()

for (const [w, h] of [[375, 667], [768, 1024], [1280, 800]]) {
  const x = await open({ width: w, height: h })
  check(`Home with the rail has no horizontal overflow at ${w}×${h}`, !(await overflow(x.page)))
  await x.ctx.close()
}
await browser.close()
console.log(failures ? `\n${failures} check(s) failed` : '\nall social checks passed')
process.exit(failures ? 1 : 0)
