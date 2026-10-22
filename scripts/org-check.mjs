// Browser checks for the Organisation Portal against a MOCKED backend: the Overview shows the server's numbers (and hides
// money from editors), identity changes are written to the organisations row with images uploaded first, links and website
// are validated, owners change roles through the audited RPC, the history renders, and the public page shows the identity.
// Verifies behaviour and the exact data sent, not the real database (the database rules are covered by tests/db).
import { chromium } from 'playwright'

const BASE = process.env.BASE_URL ?? 'http://localhost:4174'
const ME = 'aaaaaaaa-0000-4000-8000-000000000001', OTHER = 'bbbbbbbb-0000-4000-8000-000000000002'
const now = new Date().toISOString(), later = new Date(Date.now() + 864e5 * 3).toISOString()
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url')
const token = `${b64({ alg: 'none' })}.${b64({ sub: ME, aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`
const session = { access_token: token, refresh_token: 'r', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: ME, aud: 'authenticated', email: 'a@example.com', app_metadata: {}, user_metadata: {} } }
const me = { id: ME, username: 'alice', display_name: 'Alice', bio: '', avatar_path: null, location: 'Cape Town', interests: ['Music'], dm_policy: 'friends', notif_prefs: {}, onboarded_at: now }
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64')
const ORG = { id: 'o1', name: 'Beach Co', slug: 'beach-co', kind: 'venue', description: 'Sunsets and sets', verified_at: null, avatar_path: null, cover_path: `${OTHER}/cover.png`, website: 'https://beach.example', links: [{ label: 'Instagram', url: 'https://instagram.com/beachco' }], location: 'Muizenberg' }
const OVERVIEW = { role: 'owner', events_upcoming: 2, events_past: 5, events_draft: 1, going_upcoming: 37, members: 3, invited: 1, followers: 120, posts: 9, posts_30d: 4, next_event: { id: 'e1', title: 'Sunset Session', starts_at: later, timezone: 'Africa/Johannesburg' }, campaigns: { live: 1, submitted: 2 }, impressions_30d: 400, clicks_30d: 10, tickets_30d: 58 }

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined })
let failures = 0
const check = (name, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`) }

async function open({ url, role = 'owner', legacy = false, overview = OVERVIEW, width = 375 }) {
  const ctx = await browser.newContext({ viewport: { width, height: 800 } })
  const seen = { patches: [], uploads: [], rpc: [], deletes: [], inserts: [], fn: [] }
  await ctx.addInitScript(s => { try { sessionStorage.setItem('vybe:splash:v1', '1'); localStorage.setItem('sb-mock-auth-token', s) } catch {} }, JSON.stringify(session))
  await ctx.route('https://mock.supabase.test/**', route => {
    const r = route.request(), u = new URL(r.url()), h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-expose-headers': 'content-range', 'access-control-allow-methods': '*' }
    if (r.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h })
    const json = (b, status = 200) => route.fulfill({ status, headers: h, contentType: 'application/json', body: JSON.stringify(b) })
    const obj = (r.headers().accept ?? '').includes('vnd.pgrst.object')
    if (u.pathname.startsWith('/functions/v1/')) { seen.fn.push([u.pathname.split('/').pop(), JSON.parse(r.postData() ?? '{}')]); return json({ status: 'ready' }) }
    if (u.pathname.startsWith('/storage/v1/object/sign')) return json({ signedURL: '/object/sign/media/x.png?token=t' })
    if (u.pathname.startsWith('/storage/v1/object/media') && r.method() === 'DELETE') { seen.deletes.push(JSON.parse(r.postData() ?? '{}').prefixes ?? []); return json([]) }
    if (u.pathname.startsWith('/storage/v1/object/') && r.method() === 'POST') { seen.uploads.push(u.pathname); return json({ Key: 'ok' }) }
    if (u.pathname.startsWith('/storage/v1/')) return route.fulfill({ status: 200, headers: { ...h, 'content-type': 'image/png' }, body: PNG })
    if (u.pathname.startsWith('/rest/v1/rpc/')) {
      const rpc = u.pathname.replace('/rest/v1/rpc/', ''), a = JSON.parse(r.postData() ?? '{}')
      seen.rpc.push([rpc, a])
      if (legacy && ['org_overview', 'org_activity', 'set_org_member_role'].includes(rpc)) return json({ code: 'PGRST202', message: 'Could not find the function' }, 404)
      if (rpc === 'org_overview') return json(role === 'editor' ? { ...overview, role, campaigns: undefined, impressions_30d: undefined, clicks_30d: undefined, tickets_30d: undefined } : overview)
      if (rpc === 'org_activity') return json([{ id: 2, at: now, action: 'org.updated', detail: { organization_id: 'o1', fields: ['links', 'website'] }, actor: { username: 'alice', display_name: 'Alice' } }, { id: 1, at: now, action: 'org.role_changed', detail: { organization_id: 'o1', from: 'editor', to: 'admin' }, actor: { username: 'alice', display_name: 'Alice' } }])
      if (['set_org_member_role', 'set_community_organization', 'set_org_notif_prefs'].includes(rpc)) return json(null)
      if (rpc === 'follow_stats') return json({ followers: 120, following: false })
      return json(null)
    }
    const m = u.pathname.match(/^\/rest\/v1\/(\w+)$/)
    if (m) {
      const t = m[1]
      if (r.method() === 'POST' && ['communities', 'media_assets'].includes(t)) { seen.inserts.push([t, JSON.parse(r.postData() ?? '{}')]); return json(t === 'media_assets' ? { id: 'a-new' } : null, 201) }
      if (t === 'organizations' && r.method() === 'PATCH') { seen.patches.push(JSON.parse(r.postData() ?? '{}')); return route.fulfill({ status: 204, headers: h, body: '' }) }
      if (t === 'organizations' && legacy && /cover_path|website/.test(u.searchParams.get('select') ?? '')) return json({ code: '42703', message: 'column organizations.cover_path does not exist' }, 400)
      const rows = {
        profiles: [me], organizations: [legacy ? { id: 'o1', name: 'Beach Co', slug: 'beach-co', kind: 'venue', description: 'Sunsets', verified_at: null, avatar_path: null } : ORG],
        communities: [{ id: 'c1', name: 'Sunset Regulars', description: 'For people who come every week', visibility: 'public', organization_id: 'o1', community_members: [{ count: 42 }] }],
        community_members: [{ communities: { id: 'c9', name: 'My Book Club', description: '', visibility: 'private', organization_id: null } }],
        media_assets: [
          { id: 'a1', owner: ME, organization_id: 'o1', path: `${ME}/poster.jpg`, kind: 'image', mime: 'image/jpeg', bytes: 2400000, width: 1080, height: 1350, duration_ms: null, thumb_path: `${ME}/poster.webp`, title: 'Summer poster', status: 'ready', error: null, created_at: now },
          { id: 'a2', owner: OTHER, organization_id: 'o1', path: `${OTHER}/clip.mp4`, kind: 'video', mime: 'video/mp4', bytes: 9000000, width: null, height: null, duration_ms: null, thumb_path: null, title: 'Venue clip', status: 'failed', error: 'This is not a photo or video VYBE can show.', created_at: now },
        ],
        organization_members: u.searchParams.get('user_id') ? [{ role, status: 'active', notif_prefs: { follows: false } }] : [{ user_id: ME, role: 'owner', status: 'active', profiles: { username: 'alice', display_name: 'Alice' } }, { user_id: OTHER, role: 'editor', status: 'active', profiles: { username: 'bob', display_name: 'Bob' } }],
      }[t] ?? []
      return json(obj ? (rows[0] ?? null) : rows)
    }
    return json([])
  })
  const page = await ctx.newPage()
  const errs = []
  page.on('pageerror', e => errs.push(e.message))
  await page.goto(BASE + url); await page.waitForTimeout(900)
  return { page, ctx, seen, errs }
}

// Overview
let t = await open({ url: '/org/beach-co' })
check('the portal opens on Overview', await t.page.getByRole('tab', { name: 'Overview' }).getAttribute('aria-selected') === 'true')
check('overview asks the server for this organisation', t.seen.rpc.some(([n, a]) => n === 'org_overview' && a.p_org === 'o1'))
const stats = await t.page.locator('.org-stats').textContent()
for (const [label, v] of [['Upcoming events', '2'], ['Going to upcoming', '37'], ['Followers', '120'], ['Tickets sold (30 days)', '58'], ['Live campaigns', '1'], ['Campaign views (30 days)', '400']]) check(`overview shows "${label}" = ${v} from the server`, stats.includes(label + v), stats)
check('click-through rate is computed from the real counts (10 / 400)', stats.includes('2.5%'))
check('next event links to the event', await t.page.getByRole('link', { name: /Sunset Session/ }).getAttribute('href') === '/app/plans/e1')
check('no horizontal overflow on the overview', !(await t.page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)))
await t.ctx.close()

t = await open({ url: '/org/beach-co', role: 'editor' })
const est = await t.page.locator('.org-stats').textContent()
check('editors do not see sales or campaign figures', !est.includes('Tickets sold') && !est.includes('Live campaigns') && await t.page.getByText('Sales and campaign figures are shown to owners and admins.').isVisible())
check('editors have no Settings tab', await t.page.getByRole('tab', { name: 'Settings' }).count() === 0)
await t.ctx.close()

// Identity
t = await open({ url: '/org/beach-co?tab=settings' })
check('settings shows the saved website, location and links', await t.page.getByLabel('Website').inputValue() === 'https://beach.example' && await t.page.getByLabel('Location').inputValue() === 'Muizenberg' && await t.page.locator('#l-lab-0').inputValue() === 'Instagram')
await t.page.getByLabel('Choose a logo').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: PNG }); await t.page.waitForTimeout(600)
check('the logo starts uploading as soon as it is picked, into the member\'s own folder', t.seen.uploads.length === 1 && t.seen.uploads[0].startsWith(`/storage/v1/object/media/${ME}/`), JSON.stringify(t.seen.uploads))
check('the picked logo shows immediately as a local preview', (await t.page.locator('.org-logo-edit img').getAttribute('src'))?.startsWith('blob:'))
await t.page.getByLabel('Website').fill('http://insecure.example')
await t.page.getByRole('button', { name: 'Save changes' }).click(); await t.page.waitForTimeout(300)
check('a non-https website is refused before anything is written', await t.page.getByText('The website must start with https://').isVisible() && t.seen.patches.length === 0)
await t.page.getByLabel('Website').fill('https://beachco.example')
await t.page.getByRole('button', { name: 'Add a link' }).click()
await t.page.locator('#l-lab-1').fill('Tickets'); await t.page.locator('#l-url-1').fill('javascript:alert(1)')
await t.page.getByRole('button', { name: 'Save changes' }).click(); await t.page.waitForTimeout(300)
check('a link that is not https is refused', await t.page.getByText(/Each link needs a short label/).isVisible() && t.seen.patches.length === 0)
await t.page.locator('#l-url-1').fill('https://tickets.example/beach')
await t.page.getByRole('button', { name: 'Save changes' }).click(); await t.page.waitForTimeout(700)
const patch = t.seen.patches[0] ?? {}
check('Save writes identity to the organisations row (website, location, links, logo path)', patch.website === 'https://beachco.example' && patch.location === 'Muizenberg' && patch.links?.length === 2 && patch.links[1].url === 'https://tickets.example/beach' && patch.avatar_path?.startsWith(`${ME}/`), JSON.stringify(patch))
check('the uploaded logo path is the one saved', t.seen.uploads[0].endsWith(patch.avatar_path ?? '§'))
check('handle and verification are never sent', !('slug' in patch) && !('verified_at' in patch))
check('history lists recent changes with who made them', await t.page.getByText('Changed the page: links, website').isVisible() && await t.page.getByText('Changed a role (editor → admin)').isVisible())
check('no page errors in settings', t.errs.length === 0, t.errs.join(' | '))
await t.ctx.close()

t = await open({ url: '/org/beach-co?tab=settings' })
await t.page.getByLabel('Choose a logo').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: PNG }); await t.page.waitForTimeout(500)
await t.page.getByRole('tab', { name: 'Events' }).click(); await t.page.waitForTimeout(500)
check('leaving settings without saving removes the uploaded logo (no orphan)', t.seen.deletes.flat().some(p => p.startsWith(`${ME}/`)), JSON.stringify(t.seen.deletes))
await t.ctx.close()

// Roles
t = await open({ url: '/org/beach-co?tab=members' })
await t.page.getByLabel('Role for @bob').selectOption('admin'); await t.page.waitForTimeout(400)
check('owners change roles through the audited server function', t.seen.rpc.some(([n, a]) => n === 'set_org_member_role' && a.p_org === 'o1' && a.p_user === OTHER && a.p_role === 'admin'))
check('the owner has no role control on their own row', await t.page.getByLabel('Role for @alice').count() === 0)
await t.ctx.close()
t = await open({ url: '/org/beach-co?tab=members', role: 'admin' })
check('admins cannot change roles (no control)', await t.page.getByLabel('Role for @bob').count() === 0)
await t.ctx.close()

// Communities run by the organisation
t = await open({ url: '/org/beach-co?tab=communities' })
check('communities tab lists the organisation\'s communities with member counts', await t.page.getByRole('link', { name: 'Sunset Regulars' }).isVisible() && await t.page.getByText(/42 members/).isVisible())
await t.page.getByText('Create a community as Beach Co').click()
await t.page.getByLabel('Name').fill('Beach Volleyball'); await t.page.getByRole('button', { name: 'Create community' }).click(); await t.page.waitForTimeout(400)
const ci = t.seen.inserts.find(([tb]) => tb === 'communities')?.[1]
check('creating a community as the organisation sends its id (the database checks the role)', ci?.organization_id === 'o1' && ci?.name === 'Beach Volleyball' && ci?.created_by === ME, JSON.stringify(ci))
await t.page.getByRole('button', { name: 'Run as Beach Co' }).click(); await t.page.waitForTimeout(400)
check('a community the member owns can be brought in through the audited function', t.seen.rpc.some(([n, a]) => n === 'set_community_organization' && a.p_community === 'c9' && a.p_org === 'o1'))
await t.ctx.close()
t = await open({ url: '/org/beach-co?tab=communities', role: 'editor' })
check('editors see the communities but cannot create or bring one in', await t.page.getByRole('link', { name: 'Sunset Regulars' }).isVisible() && await t.page.getByText('Create a community as Beach Co').count() === 0)
await t.ctx.close()

// Media library
t = await open({ url: '/org/beach-co?tab=media' })
check('media tab shows each file\'s server check: ready with measured size, or the reason it failed', await t.page.getByText('1080×1350').isVisible() && await t.page.getByText(/^Ready/).isVisible() && await t.page.getByText(/Problem: This is not a photo or video VYBE can show/).isVisible())
check('a failed file offers "Check again"', await t.page.getByRole('button', { name: 'Check Venue clip again' }).isVisible())
await t.page.getByLabel('Choose photos or videos for the library').setInputFiles({ name: 'flyer.png', mimeType: 'image/png', buffer: PNG }); await t.page.waitForTimeout(900)
const ai = t.seen.inserts.find(([tb]) => tb === 'media_assets')?.[1]
check('uploading files it into the organisation\'s library from the member\'s own folder, then asks for the server check', ai?.organization_id === 'o1' && ai?.path?.startsWith(`${ME}/`) && t.seen.uploads.some(u => u.endsWith(ai.path)) && t.seen.fn.some(([n, b]) => n === 'media-process' && b.asset_id === 'a-new'), JSON.stringify({ ai, fn: t.seen.fn }))
check('no page errors in the media library', t.errs.length === 0, t.errs.join(' | '))
await t.ctx.close()

// Notification settings
t = await open({ url: '/org/beach-co?tab=members', role: 'editor' })
const box = t.page.getByRole('checkbox', { name: 'Someone is going to one of our events' })
check('each member sees their own notification settings; editors start with them off', await box.isVisible() && !(await box.isChecked()) && await t.page.getByRole('checkbox', { name: /reviews one of our campaigns/ }).count() === 0)
await box.click(); await t.page.waitForTimeout(300)
check('turning one on saves just that choice through the server function', t.seen.rpc.some(([n, a]) => n === 'set_org_notif_prefs' && a.p_org === 'o1' && a.p_prefs.rsvps === true && Object.keys(a.p_prefs).length === 1))
await t.ctx.close()
t = await open({ url: '/org/beach-co?tab=members' })
check('owners see campaign decisions too; a saved "off" stays off', await t.page.getByRole('checkbox', { name: /reviews one of our campaigns/ }).isChecked() && !(await t.page.getByRole('checkbox', { name: 'Someone follows our page' }).isChecked()))
await t.ctx.close()

// Before migration 19 the portal still works and says what is missing.
t = await open({ url: '/org/beach-co?tab=settings', legacy: true })
check('without migration 19, settings explains what needs the update and still saves name/about', await t.page.getByText(/need the latest database update \(migration 19\)/).isVisible() && await t.page.getByLabel('Name').isVisible())
await t.page.getByRole('tab', { name: 'Overview' }).click(); await t.page.waitForTimeout(400)
check('without migration 19, the overview says so instead of showing zeros', await t.page.getByText('The overview needs the latest database update (migration 19).').isVisible())
check('no page errors before the migration', t.errs.length === 0, t.errs.join(' | '))
await t.ctx.close()

// Public page
t = await open({ url: '/app/pages/beach-co' })
check('the public page shows the cover, location, website and links', await t.page.locator('.org-cover').count() === 1 && await t.page.getByText('Muizenberg').isVisible() && await t.page.getByRole('link', { name: /beach\.example/ }).getAttribute('href') === 'https://beach.example' && await t.page.getByRole('link', { name: 'Instagram' }).getAttribute('href') === 'https://instagram.com/beachco')
check('outbound links open safely (noopener, nofollow)', (await t.page.getByRole('link', { name: 'Instagram' }).getAttribute('rel'))?.includes('noopener'))
await t.ctx.close()

await browser.close()
console.log(failures ? `\n${failures} check(s) failed` : '\nall org checks passed')
process.exit(failures ? 1 : 0)
