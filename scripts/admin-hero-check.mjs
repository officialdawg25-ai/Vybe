// Drives Brand & Experience → Authentication Hero against a stateful MOCKED backend and checks the order of
// operations (upload → save draft → copy to public bucket → publish) and the failure paths. It validates the
// client behaviour only; server-side authorization is covered by tests/db/rls.test.ts.
import { chromium } from 'playwright'

const BASE = process.env.BASE_URL ?? 'http://localhost:4174'
const ME = 'aaaaaaaa-0000-4000-8000-000000000001'
const now = new Date().toISOString()
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url')
const token = `${b64({ alg: 'none' })}.${b64({ sub: ME, aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`
const session = { access_token: token, refresh_token: 'r', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: ME, aud: 'authenticated', email: 'a@e.com', app_metadata: {}, user_metadata: {}, created_at: now } }
const me = { id: ME, username: 'alice', display_name: 'Alice', bio: '', avatar_path: null, location: null, interests: [], dm_policy: 'friends', notif_prefs: {}, onboarded_at: now }
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64')

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined })
let failures = 0
const check = (name, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`) }

async function session_({ admin = true, failCopy = false, failPublish = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  await ctx.addInitScript(s => { localStorage.setItem('sb-mock-auth-token', s); sessionStorage.setItem('vybe:splash:v1', '1') }, JSON.stringify(session))
  const calls = []
  const state = { row: null }
  await ctx.route('https://mock.supabase.test/**', async route => {
    const r = route.request(), u = new URL(r.url()), h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-expose-headers': 'content-range' }
    const json = (body, status = 200) => route.fulfill({ status, headers: h, contentType: 'application/json', body: JSON.stringify(body) })
    if (r.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h })
    const p = u.pathname
    if (p.startsWith('/storage/v1/')) {
      calls.push(`${r.method()} ${p.replace('/storage/v1/', '')}`)
      if (p.startsWith('/storage/v1/object/sign/')) return json({ signedURL: '/object/sign/x.png?token=t' })
      if (p === '/storage/v1/object/copy') return failCopy ? json({ message: 'copy blew up', statusCode: '500', error: 'x' }, 500) : json({ Key: 'ok' })
      if (r.method() === 'GET') return route.fulfill({ status: 200, headers: h, contentType: 'image/png', body: PNG })
      return json({ Key: 'ok' })
    }
    if (p === '/rest/v1/rpc/is_admin' || p === '/rest/v1/rpc/is_staff') return json(p.endsWith('is_admin') ? admin : true)
    if (p.startsWith('/rest/v1/rpc/')) {
      const name = p.split('/').pop(); const body = r.postDataJSON?.() ?? {}
      calls.push(`rpc ${name}`)
      if (name === 'save_auth_hero_draft') { state.row = { ...(state.row ?? {}), draft: body.cfg, updated_at: now }; return json(body.cfg) }
      if (name === 'publish_auth_hero') {
        if (failPublish) return json({ message: 'media not copied', code: 'P0001' }, 400)
        state.row = { ...state.row, published: state.row.draft, published_at: now }; return json(state.row.published)
      }
      if (name === 'unpublish_auth_hero') { state.row = { ...state.row, published: null }; return json(null) }
      if (name === 'get_auth_hero') return json(state.row?.published ?? null)
      return json(null)
    }
    const m = p.match(/^\/rest\/v1\/(\w+)$/)
    if (m?.[1] === 'site_settings') { calls.push('select site_settings'); return json(state.row && (r.headers().accept ?? '').includes('vnd.pgrst.object') ? state.row : state.row ? [state.row] : (r.headers().accept ?? '').includes('vnd.pgrst.object') ? null : []) }
    if (m?.[1] === 'profiles') return json((r.headers().accept ?? '').includes('vnd.pgrst.object') ? me : [me])
    if (m?.[1] === 'reports' || m?.[1] === 'audit_log') return json([])
    return json([])
  })
  const page = await ctx.newPage()
  page.on('dialog', d => d.accept())
  await page.goto(BASE + '/admin'); await page.waitForTimeout(500)
  return { page, ctx, calls, state }
}
const brandTab = page => page.getByRole('link', { name: /Brand & Experience/ })

let s = await session_({ admin: false })
check('non-admin staff: no Brand & Experience tab', await brandTab(s.page).count() === 0)
await s.ctx.close()

s = await session_()
check('admin: Brand & Experience tab visible', await brandTab(s.page).isVisible())
await brandTab(s.page).click(); await s.page.waitForTimeout(300)
check('editor shows default status when nothing is published', await s.page.getByText('Using the VYBE default').isVisible())

// invalid file rejected client-side, before any upload
await s.page.setInputFiles('#hero-file', { name: 'x.gif', mimeType: 'image/gif', buffer: PNG })
await s.page.waitForTimeout(200)
check('GIF rejected with a clear message and no upload', await s.page.getByText(/Use a JPG, PNG or WebP image/).isVisible() && !s.calls.some(c => c.startsWith('POST object/brand-draft')))
await s.page.setInputFiles('#hero-file', { name: 'x.exe', mimeType: 'application/x-msdownload', buffer: PNG })
await s.page.waitForTimeout(200)
check('executable rejected', await s.page.getByText(/Use a JPG, PNG or WebP image/).isVisible() && !s.calls.some(c => c.startsWith('POST /storage') || c.includes('brand-draft/hero')))

await s.page.setInputFiles('#hero-file', { name: 'hero.png', mimeType: 'image/png', buffer: PNG })
await s.page.waitForTimeout(500)
check('valid image uploads to the PRIVATE draft bucket', s.calls.some(c => /^POST object\/brand-draft\/hero\/[0-9a-f-]{36}\.png$/.test(c)), s.calls.join(' | '))
check('preview appears and nothing is published yet', await s.page.getByText('Preview (draft, not yet public)').isVisible() && !s.calls.includes('rpc publish_auth_hero'))
await s.page.fill('#hero-head', 'Tonight, together.')
await s.page.fill('#hero-body', 'Plans, people, places.')
if (process.env.SHOTS) await s.page.screenshot({ path: `${process.env.SHOTS}/admin-hero-editor.png` })
await s.page.getByRole('button', { name: 'Save draft' }).click(); await s.page.waitForTimeout(400)
check('save draft calls the RPC and does not publish', s.calls.includes('rpc save_auth_hero_draft') && !s.calls.includes('rpc publish_auth_hero') && s.state.row.published == null)
check('draft config is well-formed', s.state.row.draft.media_type === 'image' && /^hero\/[0-9a-f-]{36}\.png$/.test(s.state.row.draft.path) && s.state.row.draft.headline === 'Tonight, together.')

s.calls.length = 0
await s.page.getByRole('button', { name: 'Publish' }).click(); await s.page.waitForTimeout(600)
const order = s.calls.filter(c => /save_auth_hero_draft|object\/copy|publish_auth_hero/.test(c))
check('publish order: save draft → copy to public bucket → publish', order.join(',') === 'rpc save_auth_hero_draft,POST object/copy,rpc publish_auth_hero', order.join(','))
check('published; status updated', await s.page.getByText('Published. The sign-in').isVisible())
await s.page.getByRole('button', { name: 'Mobile' }).click()
check('mobile preview switch works', await s.page.locator('.hero-preview.mobile').isVisible())
s.calls.length = 0
await s.page.getByRole('button', { name: 'Unpublish' }).click(); await s.page.waitForTimeout(400)
check('unpublish calls the RPC and removes the public copy', s.calls.includes('rpc unpublish_auth_hero') && s.calls.some(c => c.startsWith('DELETE object/brand')), s.calls.join(' | '))
await s.ctx.close()

s = await session_({ failCopy: true })
await brandTab(s.page).click(); await s.page.waitForTimeout(300)
await s.page.setInputFiles('#hero-file', { name: 'hero.png', mimeType: 'image/png', buffer: PNG }); await s.page.waitForTimeout(400)
await s.page.getByRole('button', { name: 'Publish' }).click(); await s.page.waitForTimeout(500)
check('copy failure: publish RPC is never called; previous hero stays live', !s.calls.includes('rpc publish_auth_hero') && await s.page.getByText(/previous hero is still live/).isVisible())
await s.ctx.close()

s = await session_({ failPublish: true })
await brandTab(s.page).click(); await s.page.waitForTimeout(300)
await s.page.fill('#hero-head', 'Only text'); await s.page.getByRole('button', { name: 'Publish' }).click(); await s.page.waitForTimeout(500)
check('server refusal is shown to the admin and nothing is published', await s.page.getByRole('alert').filter({ hasText: 'media not copied' }).isVisible() && s.state.row.published == null)
await s.ctx.close()

await browser.close()
console.log(failures ? `\n${failures} check(s) failed` : '\nall admin hero checks passed')
process.exit(failures ? 1 : 0)
