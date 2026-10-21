// Campaign workflow against a MOCKED backend: an organisation owner drafts, previews and submits a campaign; a rejected one
// shows VYBE's reason and can be fixed and resubmitted; a platform admin sees the review queue, cannot reject without a
// reason, and approves or rejects with exactly the right update. The database rules themselves are tested in tests/db.
import { chromium } from 'playwright'

const BASE = process.env.BASE_URL ?? 'http://localhost:4174'
const ME = 'aaaaaaaa-0000-4000-8000-000000000001', ORG = 'cccccccc-0000-4000-8000-000000000003'
const now = new Date().toISOString()
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url')
const token = `${b64({ alg: 'none' })}.${b64({ sub: ME, aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`
const session = { access_token: token, refresh_token: 'r', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: ME, aud: 'authenticated', email: 'a@example.com', app_metadata: {}, user_metadata: {} } }
const me = { id: ME, username: 'alice', display_name: 'Alice', bio: '', avatar_path: null, location: 'Cape Town', interests: [], dm_policy: 'friends', notif_prefs: {}, onboarded_at: now }
const org = { id: ORG, name: 'Sound Co', slug: 'sound-co', kind: 'organizer', description: '', verified_at: null }
const base = { subtitle: '', cta_label: 'Book', media_type: null, media_path: null, poster_path: null, focal_x: 50, focal_y: 50, accent: '#6a4cff', sound: 'chime', city: null, priority: 50, starts_at: now, ends_at: null, kind: 'sponsored', organization_id: ORG, advertiser: 'Sound Co', submitted_at: now, organizations: { name: 'Sound Co', slug: 'sound-co' } }
const rejected = { ...base, id: 'r1', title: 'Summer fest', cta_url: '/app/discover', status: 'rejected', placements: ['home'], review_note: 'Use your event page as the link.' }
const waiting = { ...base, id: 'w1', title: 'Jazz night', cta_url: 'https://soundco.example/jazz', status: 'submitted', placements: ['discover'], review_note: null }

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined })
let failures = 0
const check = (name, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`) }

async function open(path, { admin = false, rows = [] } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 900 } })
  const writes = []
  await ctx.addInitScript(s => { try { sessionStorage.setItem('vybe:splash:v1', '1'); localStorage.setItem('sb-mock-auth-token', s) } catch {} }, JSON.stringify(session))
  await ctx.route('https://mock.supabase.test/**', route => {
    const r = route.request(), u = new URL(r.url()), h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-expose-headers': 'content-range', 'access-control-allow-methods': '*' }
    if (r.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h })
    const one = (r.headers().accept ?? '').includes('vnd.pgrst.object')
    const json = (b, status = 200) => route.fulfill({ status, headers: h, contentType: 'application/json', body: JSON.stringify(b) })
    const p = u.pathname
    if (p === '/rest/v1/rpc/is_admin') return json(admin)
    if (p === '/rest/v1/rpc/is_staff') return json(admin)
    if (p === '/rest/v1/rpc/home_hero_settings') return json({})
    if (p.startsWith('/storage/v1/object/brand/')) { writes.push({ upload: p }); return json({ Key: 'ok' }) }
    if (p === '/rest/v1/promo_slides') {
      if (r.method() === 'GET') return json(rows)
      writes.push({ method: r.method(), query: u.search, body: JSON.parse(r.postData() ?? 'null') })
      return json(r.method() === 'POST' ? [{ id: 'new' }] : [], r.method() === 'POST' ? 201 : 200)
    }
    if (p === '/rest/v1/promo_stats') return json([{ slide_id: 'r1', impressions: 0, clicks: 0 }])
    if (p === '/rest/v1/organizations') return json(one ? org : [org])
    if (p === '/rest/v1/organization_members') return json(one ? { role: 'owner', status: 'active' } : [{ role: 'owner', status: 'active' }])
    if (p === '/rest/v1/profiles') return json(one ? me : [me])
    return json(one ? null : [])
  })
  const page = await ctx.newPage()
  const errs = []; page.on('pageerror', e => errs.push(e.message))
  await page.goto(BASE + path); await page.waitForTimeout(900)
  return { page, ctx, writes, errs }
}

/* Organisation owner */
let t = await open('/org/sound-co?tab=campaigns', { rows: [rejected] })
check('owners get a Campaigns tab with the rule spelled out', await t.page.getByRole('heading', { name: 'Campaigns' }).isVisible() && await t.page.getByText(/reviewed by VYBE before it goes live/).isVisible())
check('a rejected campaign shows VYBE’s reason and offers “Fix and resubmit”', await t.page.getByText('Use your event page as the link.').isVisible() && await t.page.getByRole('button', { name: 'Fix and resubmit' }).isVisible())
await t.page.getByRole('button', { name: 'New campaign' }).click()
await t.page.getByLabel('Headline').fill('Our festival')
check('the editor previews the slide, labelled as sponsored by the organisation', (await t.page.locator('.oc-preview .bb-eyebrow').textContent()) === 'Sponsored · Sound Co' && (await t.page.locator('.oc-preview .bb-title').textContent()) === 'Our festival')
await t.page.getByLabel('Link', { exact: true }).fill('javascript:alert(1)')
await t.page.getByRole('button', { name: 'Submit for review' }).click(); await t.page.waitForTimeout(200)
check('unsafe links are refused before anything is sent', await t.page.getByText(/must be an in-app path/).isVisible() && t.writes.length === 0)
await t.page.getByLabel('Link', { exact: true }).fill('/app/plans/e1')
await t.page.locator('#oc-file').setInputFiles({ name: 'fake.png', mimeType: 'image/png', buffer: Buffer.from('not really a png') })
await t.page.waitForTimeout(200)
check('a file that is not really an image is refused (checked by its bytes, not its name)', await t.page.getByText(/Use a real JPG, PNG or WebP/).isVisible() && !t.writes.some(w => w.upload))
await t.page.getByRole('checkbox', { name: /Discover hero/ }).check()
await t.page.getByRole('button', { name: 'Submit for review' }).click(); await t.page.waitForTimeout(500)
const ins = t.writes.find(w => w.method === 'POST')?.body
check('submitting sends the organisation, both placements and status “submitted”, and nothing an organisation may not set', !!ins && ins.organization_id === ORG && ins.status === 'submitted' && JSON.stringify(ins.placements) === '["home","discover"]' && !('priority' in ins) && !('kind' in ins) && !('advertiser' in ins), JSON.stringify(ins))
check('no page errors (organisation)', t.errs.length === 0, t.errs.join(' | '))
await t.ctx.close()

/* Platform admin */
t = await open('/admin/promos', { admin: true, rows: [waiting, rejected] })
check('admins see the review queue with the waiting campaign', await t.page.getByRole('heading', { name: /Review queue/ }).isVisible() && await t.page.getByLabel('Review Jazz night').isVisible())
check('the slide list says who submitted it and where it shows', await t.page.getByText(/Sponsored · Sound Co \(submitted by Sound Co\) · Home billboard/).isVisible())
const row = t.page.getByLabel('Review Jazz night')
await row.getByRole('button', { name: 'Reject' }).click(); await t.page.waitForTimeout(200)
check('rejecting needs a reason', await row.getByText('Give the organisation a reason.').isVisible() && !t.writes.some(w => w.method === 'PATCH'))
await row.getByLabel(/Reason if rejecting/).fill('Please add dates.')
await row.getByRole('button', { name: 'Reject' }).click(); await t.page.waitForTimeout(400)
const rej = t.writes.find(w => w.method === 'PATCH')
check('reject sends status “rejected” with the reason, for that campaign only', rej?.body?.status === 'rejected' && rej.body.review_note === 'Please add dates.' && rej.query.includes('id=eq.w1'), JSON.stringify(rej))
await t.page.getByLabel('Review Jazz night').getByRole('button', { name: 'Approve and publish' }).click(); await t.page.waitForTimeout(400)
const ok = t.writes.filter(w => w.method === 'PATCH').at(-1)
check('approve sends exactly status “live”', JSON.stringify(ok?.body) === '{"status":"live"}', JSON.stringify(ok))
await t.page.getByRole('button', { name: 'New slide' }).click()
check('new platform slides choose a placement and an honest label', await t.page.getByLabel('What this is (shown on the slide)').isVisible() && await t.page.getByRole('checkbox', { name: 'Discover hero' }).isVisible())
check('no page errors (admin)', t.errs.length === 0, t.errs.join(' | '))
await t.ctx.close()

await browser.close()
console.log(failures ? `\n${failures} check(s) failed` : '\nall campaign checks passed')
process.exit(failures ? 1 : 0)
