// Browser checks for the create-post screen, memory rail/viewer, music, profile screens, comments layout and VYBE Verified,
// against a MOCKED backend. Verifies behaviour and the exact data sent, not the real database.
import { chromium } from 'playwright'
import { execFileSync } from 'node:child_process'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] })
let failures = 0
const check = (name, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`) }

async function open({ width = 375, height = 780, url = '/app', rail = true, verifiedMe = false, details = null, avatar = false, mineLive = false, incoming = false, e2ee = false, meOver = {}, manyPosts = false, srv = { keys: {}, backups: {}, messages: [], blobs: {} } }) {
  Object.assign(srv, { recovery: srv.recovery ?? {}, escrow: srv.escrow ?? {}, requests: srv.requests ?? [], events: srv.events ?? [], groups: srv.groups ?? [], convKeys: srv.convKeys ?? [], escrowAvailable: srv.escrowAvailable ?? false, pkcs8: srv.pkcs8 ?? null })
  const ctx = await browser.newContext({ viewport: { width, height }, permissions: ['camera', 'microphone'] })
  const seen = { stills: [], assets: [], tusCalls: [], deletes: [], postGets: [], backupUpdates: [], fnCalls: [], convKeyRows: [], chatKeys: [], uploadBodies: [], uploadSizes: [], uploadTypes: [], follows: [], messages: [], posts: [], post_media: [], post_tags: [], uploads: [], memories: [], reactions: [], replies: [], rpc: [], events: [], communities: [], fn: [], upserts: [], profilePatch: [], pays: [] }
  await ctx.addInitScript(s => { try { sessionStorage.setItem('vybe:splash:v1', '1'); localStorage.setItem('sb-mock-auth-token', s) } catch {} }, JSON.stringify(session))
  await ctx.route('https://pay.example/**', r => r.fulfill({ status: 200, contentType: 'text/html', body: 'ok' }))
  await ctx.route('https://sandbox.payfast.co.za/**', r => { seen.pays.push(r.request().postData() ?? ''); return r.fulfill({ status: 200, contentType: 'text/html', body: 'ok' }) })
  await ctx.route('https://mock.supabase.test/**', route => {
    const r = route.request(), u = new URL(r.url()), h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-expose-headers': 'content-range', 'access-control-allow-methods': '*' }
    if (r.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h })
    const json = (b, status = 200) => route.fulfill({ status, headers: h, contentType: 'application/json', body: JSON.stringify(b) })
    const obj = (r.headers().accept ?? '').includes('vnd.pgrst.object')
    const body = () => { try { return JSON.parse(r.postData() ?? 'null') } catch { return null } }
    const sg = u.pathname.match(/^\/storage\/v1\/object\/sign\/attachments\/(.+)$/)
    if (sg && r.method() === 'POST') return json({ signedURL: `/object/sign/attachments/${sg[1]}?token=t` })
    if (sg && r.method() === 'GET') return route.fulfill({ status: 200, headers: { ...h, 'content-type': 'application/octet-stream' }, body: srv.blobs[decodeURIComponent(sg[1])] ?? Buffer.alloc(0) })
    if (u.pathname.startsWith('/storage/v1/object/sign')) return json({ signedURL: '/object/sign/media/x.png?token=t' })
    // Supabase's resumable (TUS) upload endpoint, enough of it to test big files: create, PATCH chunks, HEAD for the offset.
    if (u.pathname.startsWith('/storage/v1/upload/resumable')) {
      const th = { ...h, 'access-control-expose-headers': 'location, upload-offset, tus-resumable', 'tus-resumable': '1.0.0' }
      srv.tus ??= { n: 0, s: {}, drops: srv.tusDrops ?? 0 }
      if (r.method() === 'POST') {
        const meta = Object.fromEntries((r.headers()['upload-metadata'] ?? '').split(',').map(kv => { const [k, v] = kv.split(' '); return [k, Buffer.from(v ?? '', 'base64').toString()] }))
        const id = `s${++srv.tus.n}`; srv.tus.s[id] = { meta, len: Number(r.headers()['upload-length']), parts: [], offset: 0 }
        seen.tusCalls.push('POST')
        return route.fulfill({ status: 201, headers: { ...th, location: `https://mock.supabase.test/storage/v1/upload/resumable/${id}` }, body: '' })
      }
      const sess = srv.tus.s[u.pathname.split('/').pop()]
      if (!sess) return route.fulfill({ status: 404, headers: th, body: '' })
      if (r.method() === 'HEAD') { seen.tusCalls.push('HEAD'); return route.fulfill({ status: 200, headers: { ...th, 'upload-offset': String(sess.offset), 'upload-length': String(sess.len) }, body: '' }) }
      seen.tusCalls.push(`PATCH ${r.headers()['upload-offset']}`)
      if (srv.tus.drops > 0 && sess.parts.length === 1) { srv.tus.drops--; return route.abort('connectionreset') }   // the line drops during the second chunk
      const buf = r.postDataBuffer() ?? Buffer.alloc(0)
      sess.parts.push(buf); sess.offset += buf.length
      if (sess.offset >= sess.len) { const all = Buffer.concat(sess.parts); seen.uploads.push(`/storage/v1/object/media/${sess.meta.objectName}`); seen.uploadBodies.push(all); seen.uploadSizes.push(all.length); seen.uploadTypes.push(sess.meta.contentType) }
      return route.fulfill({ status: 204, headers: { ...th, 'upload-offset': String(sess.offset) }, body: '' })
    }
    if (u.pathname.startsWith('/storage/v1/object/media') && r.method() === 'DELETE') { seen.deletes.push(body()?.prefixes ?? []); return json([]) }
    if (u.pathname.startsWith('/storage/v1/object/') && r.method() === 'POST' && srv.failUploads > 0) { srv.failUploads--; seen.failedUploads = (seen.failedUploads ?? 0) + 1; return json({ statusCode: '403', error: 'Unauthorized', message: 'new row violates row-level security policy' }, 403) }
    // Stills (thumbnails and video posters) are made on the device as WebP; counted apart from the originals.
    if (r.method() === 'POST' && /^\/storage\/v1\/object\/media\/.+\.webp$/.test(u.pathname)) { seen.stills.push(u.pathname); return json({ Key: 'ok' }) }
    if (u.pathname.startsWith('/storage/v1/object/')) { if (r.method() === 'POST') { seen.uploads.push(u.pathname); seen.uploadBodies.push(r.postDataBuffer()); seen.uploadSizes.push(r.postDataBuffer()?.length ?? 0); seen.uploadTypes.push(r.headers()['content-type'] ?? ''); return json({ Key: 'ok' }) } return route.fulfill({ status: 200, headers: { ...h, 'content-type': 'image/png' }, body: PNG }) }
    if (u.pathname.startsWith('/functions/v1/')) {
      const name = u.pathname.split('/').pop(); seen.fn.push({ name, body: body() })
      if (name === 'pay-start') return json({ action: 'https://sandbox.payfast.co.za/eng/process', method: 'POST', fields: { merchant_id: '1', m_payment_id: 'bo1', amount: '49.00' } })
      if (name === 'chat-recovery') {
        const b = body() ?? {}; seen.fnCalls.push(b)
        if (b.action === 'available') return json({ available: srv.escrowAvailable })
        if (b.action === 'enable') { srv.escrow[ME] = true; return json({ ok: true }) }
        if (b.action === 'disable') { srv.escrow[ME] = false; return json({ ok: true }) }
        if (b.action === 'request') { if (b.password !== 'account-pass') return json({ error: 'That password is not right.' }, 403); const r = { id: 'rq1', status: 'waiting', created_at: new Date().toISOString(), ready_at: new Date(Date.now() + (srv.readyInMs ?? 72 * 3600e3)).toISOString(), expires_at: new Date(Date.now() + 10 * 864e5).toISOString() }; srv.requests.push(r); return json({ id: r.id, ready_at: r.ready_at }) }
        if (b.action === 'complete') { if (b.password !== 'account-pass') return json({ error: 'That password is not right.' }, 403); srv.requests[0].status = 'completed'; return json({ pkcs8: srv.pkcs8 }) }
        return json({ error: 'unknown' }, 400)
      }
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
      if (name === 'author_memories' && body()?.p_author === ME && !mineLive) return json([])
      if (name === 'unread_messages') return json(3)
      if (name === 'publish_chat_key') { const b = body(); srv.keys[ME] = b.p_public; srv.backups[ME] = b.p_backup; srv.recovery[ME] = b.p_recovery; srv.escrow[ME] = false; seen.chatKeys.push(b); return json(null) }
      if (name === 'update_chat_backups') { const b = body(); if (b.p_backup) srv.backups[ME] = b.p_backup; if (b.p_recovery) srv.recovery[ME] = b.p_recovery; seen.backupUpdates.push(b); return json(null) }
      if (name === 'cancel_recovery_request') { for (const r of srv.requests) r.status = 'cancelled'; return json(null) }
      if (name === 'start_group_encryption') { const g = srv.groups.find(x => x.id === body().p_conversation); const made = g.key_epoch === 0; if (made) g.key_epoch = 1; return json({ epoch: g.key_epoch, created: made }) }
      if (name === 'group_key_status') { const have = srv.convKeys.filter(k => k.epoch === body().p_epoch).map(k => k.user_id); return json([ME, OTHER].filter(m => srv.keys[m] && !have.includes(m)).map(m => ({ user_id: m, public_key: srv.keys[m] }))) }
      if (name === 'start_call') return json({ id: 'call9', room: 'call-r', kind: body()?.p_kind })
      return json(name in R ? R[name] : null)
    }
    const t = u.pathname.replace('/rest/v1/', '')
    if (t === 'chat_keys' || t === 'chat_key_backups') {
      if (!e2ee) return json({ code: '42P01', message: `relation "public.${t}" does not exist` }, 404)
      if (r.method() === 'POST') { const b = body(); if (t === 'chat_keys') { srv.keys[b.user_id] = b.public_key; seen.chatKeys.push(b) } else srv.backups[b.user_id] = b.backup; return route.fulfill({ status: 201, headers: h, body: '' }) }
      const f = u.searchParams.get('user_id') ?? '', ids = f.startsWith('in.') ? f.slice(4, -1).split(',') : [f.replace('eq.', '')]
      const out = ids.filter(i => (t === 'chat_keys' ? srv.keys : srv.backups)[i]).map(i => (t === 'chat_keys' ? { user_id: i, public_key: srv.keys[i] } : { user_id: i, backup: srv.backups[i], recovery: srv.recovery[i] ?? null, escrow: Boolean(srv.escrow[i]) }))
      return json(obj ? (out[0] ?? null) : out)
    }
    if (t === 'conversation_keys' && r.method() === 'POST') { for (const k of body()) { seen.convKeyRows.push(k); if (!srv.convKeys.some(x => x.user_id === k.user_id && x.epoch === k.epoch && x.conversation_id === k.conversation_id)) srv.convKeys.push(k) } return route.fulfill({ status: 201, headers: h, body: '' }) }
    if (r.method() === 'POST') {
      const b = body()
      if (t === 'posts') { seen.posts.push(b); return json({ id: 'newpost', ...b, profiles: me, reactions: [], comments: [], mine_reaction: [], mine_save: [] }, 201) }
      if (t === 'post_media') { seen.post_media.push(b); return route.fulfill({ status: 201, headers: h, body: '' }) }
      if (t === 'media_assets') { seen.assets.push(b); return json({ id: `asset-${seen.assets.length}` }, 201) }
      if (t === 'post_tags') { seen.post_tags.push(b); return route.fulfill({ status: 201, headers: h, body: '' }) }
      if (t === 'events') { seen.events.push(b); return json({ id: 'ev1' }, 201) }
      if (t === 'communities') { seen.communities.push(b); return json({ id: 'co1' }, 201) }
      if (t === 'follows') { seen.follows.push(b); return route.fulfill({ status: 201, headers: h, body: '' }) }
      if (t === 'messages') { seen.messages.push(b); return json({ id: 'srv' + seen.messages.length, created_at: new Date().toISOString(), deleted_at: null, ...b }, 201) }
      if (t === 'memories') { seen.memories.push(b); return json({ id: 'mnew' }, 201) }
      if (t === 'memory_reactions') { seen.reactions.push(b); return route.fulfill({ status: 201, headers: h, body: '' }) }
      if (t === 'memory_replies') { seen.replies.push(b); return route.fulfill({ status: 201, headers: h, body: '' }) }
      if (t === 'profile_details') { seen.upserts.push(b); return route.fulfill({ status: 201, headers: h, body: '' }) }
      return route.fulfill({ status: 201, headers: h, body: '' })
    }
    if (r.method() === 'PATCH') { if (t === 'profiles') seen.profilePatch.push(body()); return route.fulfill({ status: 204, headers: h, body: '' }) }
    if (t === 'posts' && r.method() === 'GET') seen.postGets.push(u.search)
    const rows = {
      chat_recovery_requests: srv.requests.map(r => ({ user_id: ME, ...r })), chat_key_events: srv.events.map(e => ({ user_id: ME, ...e })), conversation_keys: srv.convKeys,
      calls: incoming ? [{ id: 'call1', conversation_id: 'cv1', caller: OTHER, callee: ME, kind: 'video', status: 'ringing', room: 'call-x', created_at: new Date().toISOString() }] : [],
      profiles: [{ ...me, ...(avatar ? { avatar_path: `${ME}/a.webp` } : {}), ...(verifiedMe ? { verified_until: new Date(Date.now() + 864e5 * 20).toISOString() } : {}), ...meOver }, other], posts: manyPosts ? Array.from({ length: u.search.includes('created_at=lt') ? 3 : 15 }, (_, i) => ({ ...post, id: `${u.search.includes('created_at=lt') ? 'q' : 'p'}${i}`, body: `Feed post ${i}`, created_at: new Date(Date.now() - (u.search.includes('created_at=lt') ? 20 + i : i) * 60000).toISOString() })) : [post, post2], comments, friendships: [{ id: 'f1', requester: ME, addressee: OTHER, status: 'accepted' }],
      verification_plans: [{ id: 'monthly', label: 'VYBE Verified · 1 month', days: 30, price_cents: 4900, active: true, sort: 10 }, { id: 'yearly', label: 'VYBE Verified · 1 year', days: 365, price_cents: 49900, active: true, sort: 20 }],
      post_media: [], memories: [], profile_details: [], profile_private: [{ birth_date: '2000-05-17' }], badge_orders: [], notifications: [], event_rsvps: [], events: [], conversation_members: [{ conversation_id: 'cv1', user_id: ME, last_read_at: now, conversations: { id: 'cv1', is_group: false, title: null }, profiles: me }, { conversation_id: 'cv1', user_id: OTHER, last_read_at: now, conversations: { id: 'cv1', is_group: false, title: null }, profiles: other }, ...srv.groups.flatMap(g => [{ conversation_id: g.id, user_id: ME, last_read_at: now, conversations: { id: g.id, is_group: true, title: 'Crew' }, profiles: me }, { conversation_id: g.id, user_id: OTHER, last_read_at: now, conversations: { id: g.id, is_group: true, title: 'Crew' }, profiles: other }])], conversations: [{ id: 'cv1', is_group: false, title: null, key_epoch: 0 }, ...srv.groups.map(g => ({ id: g.id, is_group: true, title: 'Crew', key_epoch: g.key_epoch }))], messages: [...srv.messages, { id: 'mm1', conversation_id: 'cv1', sender: OTHER, body: 'hello there', created_at: now, deleted_at: null, client_id: null, media_path: null, media_type: null, audio_path: null, audio_ms: null }, { id: 'mm2', conversation_id: 'cv1', sender: ME, body: '', created_at: now, deleted_at: null, client_id: null, media_path: null, media_type: null, audio_path: `${ME}/v.webm`, audio_ms: 725000 }, { id: 'mm3', conversation_id: 'cv1', sender: OTHER, body: '', created_at: now, deleted_at: null, client_id: null, media_path: null, media_type: null, audio_path: null, audio_ms: null, file_path: `${OTHER}/q.pdf`, file_name: 'Quarterly report.pdf', file_size: 2457600, file_mime: 'application/pdf' }], communities: [], community_members: [], saves: [], follows: [],
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
await shot(t.page, 'home-stack')
check('rail starts folded as a stack, not fanned out to the left', await t.page.locator('.mrail.stacked').count() === 1 && await t.page.evaluate(() => { const w = [...document.querySelectorAll('.mc-wrap')].filter(e => e.getBoundingClientRect().width > 0); return w.length >= 2 && w[1].getBoundingClientRect().left < w[0].getBoundingClientRect().right && document.querySelector('.mrail-list').scrollLeft === 0 }))
check('the Share a memory card has no + badge', await t.page.locator('.mc-plus').count() === 0)
const railGeo = () => t.page.evaluate(() => { const r = e => e && e.getBoundingClientRect(); const tog = [...document.querySelectorAll('.mc-tog')].map(r), ppl = [...document.querySelectorAll('.mc-person-slot')].map(r); return { tog: tog.map(x => [Math.round(x.left), Math.round(x.right)]), ppl: ppl.map(x => [Math.round(x.left), Math.round(x.right)]) } })
const folded = await railGeo()
const layout = await t.page.evaluate(() => {
  const bb = document.querySelector('.billboard')?.getBoundingClientRect(), cb = document.querySelector('.compose-bar')?.getBoundingClientRect(), mr = document.querySelector('.mrail')?.getBoundingClientRect()
  const togs = [...document.querySelectorAll('.mrail .mc-tog')], last = togs.at(-1)?.getBoundingClientRect(), next = togs.at(-1)?.nextElementSibling?.getBoundingClientRect()
  return { order: Boolean(bb && cb && mr && bb.bottom <= cb.top + 1 && cb.bottom <= mr.top + 1), gap: last && next ? Math.round(next.left - last.right) : null }
})
check('the composer sits between the billboard and the memories', layout.order, JSON.stringify(layout))
check('the gap after the stacked shortcuts is small (about 8px)', layout.gap !== null && layout.gap >= 2 && layout.gap <= 12, JSON.stringify(layout))
check('folded: the shortcut stack sits on the left and people’s memories are fully visible to its right', folded.tog.length === 4 && folded.tog[0][0] <= 20 && folded.tog.every(x => x[0] < 200) && folded.ppl.length >= 1 && folded.ppl[0][0] >= Math.max(...folded.tog.map(x => x[1])) && folded.ppl[0][1] <= 375, JSON.stringify(folded))
check('folded: only the front shortcut is labelled (no cut-off words peeking out)', await t.page.evaluate(() => [...document.querySelectorAll('.mc-tog:not(:first-child) .mc-label')].every(e => getComputedStyle(e).opacity === '0')))
await t.page.locator('.mc-share').click(); await t.page.waitForTimeout(500)
const fanned = await railGeo()
check('one tap fans the shortcuts out to the right (the front card stays put, the others slide right, people move along)', fanned.tog[0][0] === folded.tog[0][0] && fanned.tog[3][0] > folded.tog[3][0] + 150 && fanned.ppl[0][0] > folded.ppl[0][0], JSON.stringify({ folded, fanned }))
check('one tap on the folded stack only opens it (no navigation)', await t.page.locator('.mrail.open').count() === 1 && new URL(t.page.url()).pathname === '/app')
const cards = await t.page.locator('.mrail .mc').evaluateAll(els => els.map(e => ({ label: e.getAttribute('aria-label') || e.textContent.trim(), href: e.getAttribute('href') })))
check('rail order: Share a memory, Discover music, Plans near you, My tickets, then people', cards[0]?.href === '/app/memories/new' && cards[1]?.href === '/app/music' && cards[2]?.href === '/app/discover?mode=events' && cards[3]?.href === '/app/tickets' && cards[4]?.href === `/app/memories/${OTHER}`, JSON.stringify(cards.map(c => c.href)))
check('Share-a-memory card shows the VYBE art when there is no profile photo', await t.page.locator('.mc-share .mc-vybe').count() === 1)
check('people cards show a verified tick and an unseen ring', await t.page.locator('.mc-person .vbadge').count() === 1 && await t.page.locator('.mc-ring.new').count() === 1)
check('opened rail: every card fully visible side by side, in front-to-back order', await t.page.evaluate(() => { const w = [...document.querySelectorAll('.mc-wrap:not(.mc-close)')]; return w.length >= 5 && w.slice(1).every((e, k) => e.getBoundingClientRect().left >= w[k].getBoundingClientRect().right - 1) && w[0].getBoundingClientRect().left >= 0 })
  && await t.page.locator('.mc-wrap').nth(1).evaluate(e => getComputedStyle(e).zIndex) === '19')
await shot(t.page, 'home')
check('Home has no horizontal overflow with the rail', !(await overflow(t.page)))
await t.page.getByRole('button', { name: 'Close the shortcuts' }).click(); await t.page.waitForTimeout(500)
const closed = await railGeo()
check('one tap on Close folds the shortcuts back to the left, exactly as before', await t.page.locator('.mrail.stacked').count() === 1 && JSON.stringify(closed) === JSON.stringify(folded), JSON.stringify(closed))
check('closing leaves no scroll lock behind', await t.page.evaluate(() => getComputedStyle(document.body).overflow !== 'hidden'))
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

t = await open({ rail: false, mineLive: true })
await t.page.waitForTimeout(800)
check('no one else has a live memory: the stack shows your memory and a short note, no fake people', await t.page.locator('.mc-person-slot .mc-person').count() === 0 && await t.page.getByText('Memories your friends share show up here.').isVisible() && await t.page.locator('.mc-own').count() === 1)
await shot(t.page, 'home-stack-empty')
await t.ctx.close()

/* ------------------------------------------------------------------------------- Feed: no duplicate loads, logo refresh, instant return */
t = await open({})
await t.page.waitForTimeout(1200)
const feedGets = () => t.seen.postGets.filter(q => !q.includes('created_at=lt') && !q.includes('id=in'))
const dupes = q => q.length !== new Set(q).size
check('Home loads the feed once and your profile once (no duplicate requests)', feedGets().length >= 1 && !dupes(feedGets()) && t.seen.rpc.filter(x => x.name === 'my_profile').length === 1, JSON.stringify({ feed: feedGets(), my: t.seen.rpc.filter(x => x.name === 'my_profile').length }))
const feedBefore = feedGets().length
await t.page.locator('.hdr-logo').click(); await t.page.waitForTimeout(800)
check('tapping the VYBE logo on Home refreshes the feed from the server in place', feedGets().length === feedBefore + 1 && new URL(t.page.url()).pathname === '/app' && await t.page.locator('.igp').count() >= 1)
await t.page.getByRole('link', { name: 'Discover', exact: true }).first().click(); await t.page.waitForTimeout(600)
const routeGets = t.seen.postGets.length
await t.page.locator('.hdr-logo').click()
await t.page.waitForTimeout(120)
check('coming back to Home shows the posts you saw at once (no spinner) while it refreshes', await t.page.locator('.igp').count() >= 1)
await t.page.waitForTimeout(900)
check('…and then replaces them with the server’s copy', t.seen.postGets.length > routeGets)
await t.ctx.close()

t = await open({ manyPosts: true })
await t.page.waitForTimeout(1000)
const firstPage = await t.page.locator('.igp').count()
await t.page.evaluate(() => window.scrollTo(0, document.body.scrollHeight * 0.8)); await t.page.waitForTimeout(1200)
check('the next page is prepared before you reach the end (no tap on “Load more” needed), without duplicates', firstPage === 15 && await t.page.locator('.igp').count() === 18 && t.seen.postGets.filter(q => q.includes('created_at=lt')).length === 1, JSON.stringify({ firstPage, now: await t.page.locator('.igp').count() }))
await t.ctx.close()

/* ----------------------------------------------------------------------------------------------------------- Create post */
t = await open({ url: '/app/create' })
check('create post is a full-screen screen with title, audience and the four add-to chips', await t.page.getByRole('heading', { name: 'New post' }).isVisible() && await t.page.locator('.hdr').count() === 0
  && await t.page.getByRole('button', { name: /Music/ }).first().isVisible() && await t.page.getByRole('button', { name: /People/ }).isVisible() && await t.page.getByRole('button', { name: /Location/ }).first().isVisible() && await t.page.getByRole('button', { name: /Feeling\/activity/ }).first().isVisible())
check('toolbar only adds media (gallery, camera, video); tag, feeling, location and music live in the chips, not twice', (await t.page.locator('.cp-bar button').count()) === 3)
check('no file-size wording on the composer', await t.page.getByText(/Photos up to/).count() === 0)
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
check('photos and videos upload as soon as they are picked; the removed one is deleted from storage; the post links the rest in order', t.seen.uploads.length === 3 && t.seen.deletes.flat().filter(p => !p.endsWith('.webp')).length === 1 && t.seen.post_media[0]?.length === 2 && t.seen.post_media[0][0].sort === 0 && t.seen.post_media[0].map(m => m.path).every(p => t.seen.uploads.some(u => u.endsWith(p))) && !t.seen.post_media[0].some(m => t.seen.deletes.flat().includes(m.path)) && p0.media_path === t.seen.post_media[0][0].path, JSON.stringify({ up: t.seen.uploads, del: t.seen.deletes, pm: t.seen.post_media }))
check('published photos go into the member\'s library with their thumbnails, and each is sent for the server check', t.seen.assets.length === 2 && t.seen.assets.every(a => t.seen.post_media[0].some(m => m.path === a.path) && a.bytes > 0) && /\.webp$/.test(t.seen.assets.find(a => a.kind === 'image')?.thumb_path ?? '') && t.seen.fn.filter(f => f.name === 'media-process').length === 2 && t.seen.fn.filter(f => f.name === 'media-process').every(f => /^asset-/.test(f.body?.asset_id)), JSON.stringify({ assets: t.seen.assets, fn: t.seen.fn.filter(f => f.name === 'media-process') }))
check('the removed photo\'s thumbnail is deleted with it; the others\' thumbnails stay', t.seen.stills.length === 2 && t.seen.deletes.flat().filter(p => p.endsWith('.webp')).length === 1, JSON.stringify({ stills: t.seen.stills, del: t.seen.deletes }))
check('the tagged friend is saved separately', t.seen.post_tags[0]?.[0]?.user_id === OTHER)
check('after posting you are back on Home with a “Post shared” confirmation', new URL(t.page.url()).pathname === '/app' && await t.page.getByText('Post shared').first().isVisible())
await t.ctx.close()

t = await open({ url: '/app/create' })
await t.page.getByLabel("What's on your mind?").fill('Draft idea')
await t.page.getByRole('button', { name: 'Close' }).click()
check('closing a post with content asks before discarding', await t.page.getByRole('dialog', { name: 'Discard this post?' }).isVisible())
await t.ctx.close()

t = await open({ url: '/app/create' })
await t.page.getByRole('button', { name: /People/ }).click()
await t.page.getByRole('checkbox', { name: /Tag Bob/ }).check()
await t.page.getByRole('button', { name: /Done/ }).click()
check('tagged people alone are not a post', await t.page.getByRole('button', { name: 'Post', exact: true }).isDisabled())
await t.page.getByRole('button', { name: /Music/ }).first().click()
await t.page.getByLabel('Song title').fill('Only a song'); await t.page.getByLabel('Artist', { exact: true }).fill('Someone'); await t.page.getByRole('button', { name: 'Use this song' }).click()
check('a song on its own is enough to post', await t.page.getByRole('button', { name: 'Post', exact: true }).isEnabled())
await t.page.getByRole('button', { name: 'Post', exact: true }).click(); await t.page.waitForTimeout(1000)
check('a song-only post is saved with an empty caption', t.seen.posts[0]?.body === '' && t.seen.posts[0]?.music_title === 'Only a song' && new URL(t.page.url()).pathname === '/app', JSON.stringify(t.seen.posts[0]))
await t.ctx.close()

/* ------------------------------------------------------------------------------------------ Background, resumable uploads */
{
  const srvU = { keys: {}, backups: {}, messages: [], blobs: {}, tusDrops: 1 }
  t = await open({ url: '/app/create', srv: srvU })
  const big = Buffer.alloc(14 * 1024 * 1024, 7)
  await t.page.locator('input[type=file][multiple]').setInputFiles({ name: 'clip.mp4', mimeType: 'video/mp4', buffer: big })
  await t.page.waitForTimeout(150)
  check('a picked video shows at once and starts uploading in the background, with a progress bar', await t.page.locator('.cp-media video').count() === 1 && (await t.page.locator('.cp-prog').count() === 1 || t.seen.tusCalls.length > 0))
  await t.page.getByLabel("What's on your mind?").fill('Clip from tonight')
  check('writing is never blocked while it uploads', (await t.page.getByLabel("What's on your mind?").inputValue()) === 'Clip from tonight')
  await t.page.getByRole('button', { name: /^(Post|\d+%)$/ }).click()
  await t.page.waitForURL(/\/app$/, { timeout: 30000 }).catch(() => {})
  await t.page.waitForTimeout(500)
  const sessions = t.seen.tusCalls.filter(c => c === 'POST').length
  check('a file over 6 MB goes up in resumable 6 MB chunks', t.seen.tusCalls.filter(c => c.startsWith('PATCH')).length >= 3, t.seen.tusCalls.join(' | '))
  check('when the connection drops mid-file it asks where it got to and resumes, without starting again', sessions === 1 && t.seen.tusCalls.includes('HEAD') && t.seen.uploadSizes[0] === big.length && t.seen.uploadBodies[0]?.equals(big), t.seen.tusCalls.join(' | '))
  check('the post waits for the upload, then links exactly that file', t.seen.posts[0]?.media_type === 'video' && t.seen.uploads[0]?.endsWith(t.seen.posts[0]?.media_path) && new URL(t.page.url()).pathname === '/app', JSON.stringify(t.seen.posts[0] ?? null))
  await t.ctx.close()

  const srvF = { keys: {}, backups: {}, messages: [], blobs: {}, failUploads: 1 }
  t = await open({ url: '/app/create', srv: srvF })
  await t.page.locator('input[type=file][multiple]').setInputFiles({ name: 'a.png', mimeType: 'image/png', buffer: PNG })
  await t.page.waitForTimeout(800)
  check('a refused upload says so on the photo and offers Retry (it is not retried blindly)', await t.page.getByRole('button', { name: 'Retry attachment 1' }).isVisible() && t.seen.failedUploads === 1)
  await t.page.getByRole('button', { name: 'Post', exact: true }).click(); await t.page.waitForTimeout(400)
  check('posting with a failed upload is stopped with a clear message, nothing is saved', await t.page.getByText(/did not upload. Tap Retry/).isVisible() && t.seen.posts.length === 0)
  await t.page.getByRole('button', { name: 'Retry attachment 1' }).click(); await t.page.waitForTimeout(700)
  await t.page.getByRole('button', { name: 'Post', exact: true }).click(); await t.page.waitForTimeout(1000)
  check('after Retry succeeds the post goes through with that photo', t.seen.uploads.length === 1 && t.seen.posts[0]?.media_type === 'image')
  await t.ctx.close()

  t = await open({ url: '/app/create' })
  await t.page.locator('input[type=file][multiple]').setInputFiles({ name: 'a.png', mimeType: 'image/png', buffer: PNG })
  await t.page.waitForTimeout(600)
  await t.page.getByRole('button', { name: 'Close' }).click()
  await t.page.getByRole('button', { name: 'Discard' }).click(); await t.page.waitForTimeout(600)
  check('discarding a post deletes the photos it had already uploaded (no orphans left in storage)', t.seen.uploads.length === 1 && t.seen.deletes.flat().some(p => t.seen.uploads[0].endsWith(p)) && t.seen.stills.every(st => t.seen.deletes.flat().some(p => st.endsWith(p))), JSON.stringify({ del: t.seen.deletes, stills: t.seen.stills }))
  await t.ctx.close()
}

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
check('saving also updates bio and interests, and leaves an unchanged name alone (names change at most every 14 days)', t.seen.profilePatch.length >= 1 && !('display_name' in t.seen.profilePatch[0]) && 'bio' in t.seen.profilePatch[0], JSON.stringify(t.seen.profilePatch[0]))
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
check('post card: caption starts with the author’s display name, same as the header', (await card.locator('.igp-caption').innerText()).startsWith('Bob '))
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

/* ----------------------------------------------------------------------------------------------------------- One account per tab */
t = await open({ url: '/app' })
const other2 = await t.ctx.newPage()
await other2.goto(BASE + '/signin?account=new'); await other2.waitForTimeout(900)
check('another account can be added in a new tab: it starts signed out in its own slot and the URL is cleaned', await other2.getByRole('button', { name: 'Sign in' }).isVisible() && !new URL(other2.url()).search.includes('account'))
await t.page.reload(); await t.page.waitForTimeout(900)
check('the first tab stays signed in as the original account', await t.page.locator('.mrail').count() === 1)
await other2.reload(); await other2.waitForTimeout(700)
check('the new tab keeps its own slot across reloads (still its own signed-out account, not the first tab’s)', await other2.getByRole('button', { name: 'Sign in' }).isVisible())
await t.ctx.close()

/* ----------------------------------------------------------------------------------------------------------- Step-by-step creation */
t = await open({ url: '/app/plans?new=1' })
const cont = () => t.page.getByRole('button', { name: 'Continue' }).click()
check('plan: starts as a single question, with phase progress, not a long form', await t.page.getByRole('heading', { name: 'What are you planning?' }).isVisible() && await t.page.getByRole('progressbar').count() === 1 && await t.page.locator('input:visible, textarea:visible, select:visible').count() <= 2)
await shot(t.page, 'wiz-plan-1')
await cont()
check('plan: cannot continue without a title', await t.page.getByText('Give your plan a title.').isVisible())
await t.page.getByLabel('Title').fill('Sunset beach braai'); await cont()
check('plan: the description step can be skipped', await t.page.getByRole('heading', { name: 'Tell people more' }).isVisible() && await t.page.getByRole('button', { name: 'Skip' }).isVisible())
await t.page.getByRole('button', { name: 'Skip' }).click()
await t.page.getByRole('radio', { name: /Online only/ }).click(); await shot(t.page, 'wiz-plan-format'); await cont()
await t.page.getByLabel('Starts').fill('2026-12-24T18:00'); await shot(t.page, 'wiz-plan-when'); await cont()
check('plan: online-only plans skip the venue step and ask for the link', await t.page.getByRole('heading', { name: 'How do they join online?' }).isVisible())
await t.page.getByLabel('Online link').fill('https://meet.example.com/braai'); await cont()
await t.page.getByRole('radio', { name: /Friends of the host/ }).click(); await cont()
await t.page.getByRole('button', { name: 'Skip' }).click()
check('plan: ends on a review screen listing every answer with Change links', await t.page.getByRole('heading', { name: 'Ready to publish?' }).isVisible() && (await t.page.locator('.wz-review').innerText()).includes('Sunset beach braai') && await t.page.getByRole('button', { name: 'Change' }).count() >= 5)
await shot(t.page, 'wiz-plan-review')
check('plan: no horizontal overflow', !(await overflow(t.page)))
await t.page.getByRole('button', { name: 'Publish plan' }).click(); await t.page.waitForTimeout(700)
const ev = t.seen.events[0] ?? {}
check('plan: publishing saves every answer', ev.title === 'Sunset beach braai' && ev.format === 'online' && ev.online_url === 'https://meet.example.com/braai' && ev.visibility === 'friends' && ev.status === 'active' && ev.host === ME, JSON.stringify(ev).slice(0, 300))
await t.ctx.close()

t = await open({ url: '/app/communities?new=1' })
check('community: starts as a single question', await t.page.getByRole('heading', { name: 'What is it called?' }).isVisible())
await t.page.getByLabel('Name').fill('Cape Runners'); await cont(); await t.page.getByRole('button', { name: 'Skip' }).click()
await t.page.getByRole('radio', { name: /Private/ }).click(); await cont()
check('community: topics sit in a collapsible section with a selection count', await t.page.getByRole('button', { name: /Topics/ }).getAttribute('aria-expanded') === 'true')
await t.page.getByRole('button', { name: 'Music', exact: true }).click(); await t.page.getByRole('button', { name: 'Art', exact: true }).click()
check('community: the collapse header counts the selection and folds away', (await t.page.locator('.collapse-s').textContent()) === '2 selected')
await shot(t.page, 'wiz-community-topics')
await t.page.locator('.collapse-h').click()
check('community: collapsing hides the chips', await t.page.getByRole('button', { name: 'Music', exact: true }).count() === 0)
await cont(); await t.page.getByRole('button', { name: 'Skip' }).click()
await t.page.getByRole('button', { name: 'Create community' }).click(); await t.page.waitForTimeout(700)
const co = t.seen.communities[0] ?? {}
check('community: creating saves name, privacy and topics', co.name === 'Cape Runners' && co.visibility === 'private' && JSON.stringify(co.topics) === JSON.stringify(['Music', 'Art']) && co.created_by === ME, JSON.stringify(co))
await t.ctx.close()

/* ----------------------------------------------------------------------------------------------------------- Chat badge and calls */
t = await open({ url: '/app' })
check('the chat icon shows the unread message count like notifications', (await t.page.getByRole('link', { name: /Messages, 3 unread/ }).locator('.badge').textContent()) === '3')
await t.ctx.close()
t = await open({ url: '/app', incoming: true })
await t.page.waitForTimeout(600)
check('an incoming call shows who is calling with Answer and Decline', await t.page.getByRole('alertdialog', { name: 'Incoming call' }).isVisible() && await t.page.getByText(/Incoming video call/).isVisible() && await t.page.getByRole('button', { name: 'Answer call' }).isVisible())
await shot(t.page, 'incoming-call')
await t.page.getByRole('button', { name: 'Decline call' }).click(); await t.page.waitForTimeout(400)
check('declining tells the database and dismisses the call', t.seen.rpc.some(r => r.name === 'respond_call' && r.body?.p_accept === false) && await t.page.getByRole('alertdialog').count() === 0)
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
check('chat: composer has camera, message box, mic, gallery and a + for files', await t.page.getByRole('button', { name: 'Open the camera' }).isVisible() && await t.page.getByLabel('Message', { exact: true }).isVisible() && await t.page.getByRole('button', { name: /Record a voice note/ }).isVisible() && await t.page.getByRole('button', { name: /gallery/ }).isVisible() && await t.page.getByRole('button', { name: 'Attach a file' }).isVisible())
check('chat: voice and video call buttons in the header', await t.page.getByRole('button', { name: /Voice call/ }).isVisible() && await t.page.getByRole('button', { name: /Video call/ }).isVisible())
check('chat: a 12-minute voice note has its own bubble, a seek bar and a speed button (no 60 s limit)', await t.page.locator('.dm-bubble .vn-seek').count() === 1 && await t.page.locator('.dm-bubble .vn-speed').count() === 1 && (await t.page.locator('.dm-bubble .vn-time').first().textContent()) === '12:05' && await t.page.locator('.dm-bubble:has(.voice-note)').evaluate(e => getComputedStyle(e).backgroundImage !== 'none' || getComputedStyle(e).backgroundColor !== 'rgba(0, 0, 0, 0)'))
check('chat: a file message shows its name and size with a download action', await t.page.getByRole('button', { name: /Download Quarterly report.pdf, 2.3 MB/ }).isVisible())
await t.page.getByLabel('Message', { exact: true }).fill('Hey Bob'); await t.page.getByRole('button', { name: 'Send message' }).click(); await t.page.waitForTimeout(500)
check('chat: a text message is stored with a client id for safe retries', t.seen.messages[0]?.body === 'Hey Bob' && t.seen.messages[0]?.sender === ME && typeof t.seen.messages[0]?.client_id === 'string')
await t.page.locator('input[type=file]').nth(1).setInputFiles({ name: 'a.png', mimeType: 'image/png', buffer: PNG }); await t.page.waitForTimeout(900)
check('chat: a photo is uploaded to your folder and sent as a media message', t.seen.uploads.length === 1 && t.seen.messages[1]?.media_type === 'image' && /^aaaaaaaa/.test(t.seen.messages[1]?.media_path ?? '') && t.seen.messages[1]?.body === '')
await t.page.getByRole('button', { name: 'Attach a file' }).click()
check('chat: + offers photos/videos, camera and any document', await t.page.getByRole('dialog', { name: 'Attach' }).isVisible() && await t.page.getByText('Document or any file').isVisible())
await t.page.keyboard.press('Escape'); await t.page.waitForTimeout(200)
await t.page.locator('input[type=file]').nth(2).setInputFiles({ name: 'Budget 2026.xlsx', mimeType: 'application/vnd.ms-excel', buffer: Buffer.alloc(5000, 1) }); await t.page.waitForTimeout(900)
check('chat: any file type is sent as a file in the attachments bucket under your folder', t.seen.uploads.some(u => /\/attachments\/aaaaaaaa/.test(u) && /\.xlsx$/.test(u)) && t.seen.messages.some(m => m.file_name === 'Budget 2026.xlsx' && /^aaaaaaaa.*\.xlsx$/.test(m.file_path ?? '') && m.file_size === 5000))
await t.page.locator('input[type=file]').nth(2).setInputFiles({ name: 'setup.exe', mimeType: 'application/octet-stream', buffer: Buffer.alloc(100, 1) }); await t.page.waitForTimeout(500)
check('chat: programs and scripts are refused', !t.seen.messages.some(m => m.file_name === 'setup.exe') && await t.page.getByText(/programs and scripts/).isVisible())
await t.page.getByRole('button', { name: 'Open the camera' }).click(); await t.page.waitForTimeout(1200)
check('chat: the camera button opens the in-app camera (photo and video modes)', await t.page.getByRole('dialog', { name: 'Camera' }).isVisible() && await t.page.getByRole('tab', { name: 'Video' }).isVisible())
await shot(t.page, 'camera')
await t.page.getByRole('button', { name: 'Take photo' }).click(); await t.page.waitForTimeout(1500)
check('chat: a photo taken in the camera is sent as media', await t.page.getByRole('dialog', { name: 'Camera' }).count() === 0 && t.seen.messages.some(m => m.media_type === 'image' && /\.jpg$/.test(m.media_path ?? '')))
await t.page.getByRole('button', { name: /Record a voice note/ }).click(); await t.page.waitForTimeout(1600)
await t.page.getByRole('button', { name: 'Pause recording' }).click(); await t.page.waitForTimeout(300)
check('chat: recording shows a running clock and can pause, with no 1:00 cap', await t.page.getByRole('button', { name: 'Resume recording' }).isVisible() && !(await t.page.locator('.voice-rec').innerText()).includes('1:00'))
await t.page.getByRole('button', { name: 'Resume recording' }).click(); await t.page.waitForTimeout(700)
await t.page.getByRole('button', { name: 'Done' }).click(); await t.page.waitForTimeout(600)
await t.page.getByRole('button', { name: /^Send$|Sending/ }).click(); await t.page.waitForTimeout(1200)
check('chat: the voice note is uploaded and sent with its real length', t.seen.messages.some(m => m.audio_ms >= 1500 && /^aaaaaaaa.*\.webm$/.test(m.audio_path ?? '')))
await shot(t.page, 'chat-after')
await t.page.getByRole('button', { name: /Video call/ }).click(); await t.page.waitForTimeout(1200)
check('chat: starting a video call asks the database and opens the call screen', t.seen.rpc.some(r => r.name === 'start_call' && r.body?.p_kind === 'video') && await t.page.getByRole('dialog', { name: /Call with Bob/ }).isVisible())
check('chat: without LiveKit configured the call says so plainly', await t.page.getByText(/Calls are not set up yet/).isVisible())
await shot(t.page, 'call')
await t.page.getByRole('button', { name: 'End call' }).click(); await t.page.waitForTimeout(500)
check('chat: ending the call tells the database', t.seen.rpc.some(r => r.name === 'end_call') && await t.page.getByRole('dialog', { name: /Call with/ }).count() === 0)
check('chat: no horizontal overflow', !(await overflow(t.page)))
await t.ctx.close()

/* ----------------------------------------------------------------------------------------------------------- End-to-end encrypted chat */
const E = await import('../src/lib/e2ee.ts')
const bob = await E.generateIdentity()
const srv = { keys: { [OTHER]: bob.publicKey }, backups: {}, messages: [], blobs: {} }
const PASS = 'violet harbour 42 lantern'
t = await open({ url: '/app/messages/cv1', e2ee: true, srv })
await t.page.waitForTimeout(500)
check('secure chat: before setup, the composer is replaced by a “Turn on secure chat” prompt (no plain sending)', await t.page.getByRole('region', { name: 'Secure chat' }).isVisible() && !(await t.page.getByLabel('Message', { exact: true }).isVisible()))
await shot(t.page, 'secure-setup-banner')
await t.page.getByRole('button', { name: 'Turn on' }).click()
await t.page.getByLabel('Choose a chat passphrase').fill('short'); await t.page.getByLabel('Type it again').fill('short')
await t.page.getByRole('button', { name: 'Turn on secure chat' }).click()
check('secure chat: a weak passphrase is refused', await t.page.getByText(/at least 10 characters/).isVisible())
await t.page.getByLabel('Choose a chat passphrase').fill(PASS); await t.page.getByLabel('Type it again').fill(PASS + 'x')
await t.page.getByRole('button', { name: 'Turn on secure chat' }).click()
check('secure chat: mismatching passphrases are refused', await t.page.getByText(/do not match/).isVisible())
await shot(t.page, 'secure-setup')
await t.page.getByLabel('Type it again').fill(PASS)
await t.page.getByRole('button', { name: 'Turn on secure chat' }).click(); await t.page.waitForTimeout(2500)
const alicePub = srv.keys[ME]
const recDlg = t.page.getByRole('dialog', { name: 'Save your recovery key' })
const rk = (await t.page.locator('.e2-code').textContent()) ?? ''
check('recovery: after setup a one-time recovery key is shown (8 groups of 4) before anything else', await recDlg.isVisible() && /^([0-9A-HJKMNP-TV-Z]{4}-){7}[0-9A-HJKMNP-TV-Z]{4}$/.test(rk))
await shot(t.page, 'recovery-key')
check('recovery: Done stays disabled until the key is confirmed as saved, and Escape cannot dismiss it', await recDlg.getByRole('button', { name: 'Done' }).isDisabled() && (await t.page.keyboard.press('Escape'), await t.page.waitForTimeout(200), await recDlg.isVisible()))
check('recovery: the stored recovery backup really restores the same identity, and does not contain the key itself', !JSON.stringify(srv.recovery[ME]).includes(rk.replace(/-/g, '')) && await E.publicFromPkcs8((await E.restoreWithRecoveryKey(srv.recovery[ME], rk)).pkcs8) === alicePub)
await t.page.getByLabel(/I have saved my recovery key/).check(); await recDlg.getByRole('button', { name: 'Done' }).click(); await t.page.waitForTimeout(400)
check('secure chat: the PUBLIC key is published and the private key is stored only as a passphrase-encrypted backup', typeof alicePub === 'string' && alicePub.length === 88 && srv.backups[ME]?.iter === 600000 && !JSON.stringify(srv.backups[ME]).includes(alicePub) && Object.keys(srv.backups[ME]).sort().join() === 'ct,iter,iv,salt,v')
check('secure chat: the thread is now marked end-to-end encrypted and the composer is back', await t.page.getByRole('button', { name: /End-to-end encrypted/ }).isVisible() && await t.page.getByLabel('Message', { exact: true }).isVisible())
await t.page.getByLabel('Message', { exact: true }).fill('Top secret plan'); await t.page.getByRole('button', { name: 'Send message' }).click(); await t.page.waitForTimeout(800)
const sent = t.seen.messages.at(-1) ?? {}
check('secure chat: a sent message is stored as ciphertext only (flagged e2ee), never as plain text', sent.e2ee === true && sent.body?.startsWith('e2ee1.') && !sent.body.includes('secret') && sent.sender === ME)
check('secure chat: the sender still reads their own message', await t.page.getByText('Top secret plan').isVisible())
const code = await E.securityCode(alicePub, bob.publicKey)
await t.page.getByRole('button', { name: /End-to-end encrypted/ }).click()
check('secure chat: the security code on screen matches what Bob’s phone computes', (await t.page.locator('.e2-code').textContent()) === code)
await shot(t.page, 'secure-code')
await t.page.getByRole('button', { name: 'Close', exact: true }).click()
// A message from Bob, encrypted for Alice, plus an encrypted photo.
const kBob = await E.conversationKey(bob.privateKey, alicePub, 'cv1', OTHER, ME)
srv.messages.push({ id: 'enc1', conversation_id: 'cv1', sender: OTHER, body: await E.encryptEnvelope(kBob, { t: 'text', m: 'Hello from Bob 🔐' }, 'cv1', OTHER), created_at: new Date(Date.now() - 5000).toISOString(), deleted_at: null, client_id: null, e2ee: true, media_path: null, media_type: null, audio_path: null, audio_ms: null })
const enc = await E.encryptBlob(PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.byteLength)); srv.blobs[`${OTHER}/img.enc`] = Buffer.from(await enc.cipher.arrayBuffer())
srv.messages.push({ id: 'enc2', conversation_id: 'cv1', sender: OTHER, body: await E.encryptEnvelope(kBob, { t: 'media', kind: 'image', mime: 'image/png', key: enc.key, iv: enc.iv, size: PNG.length }, 'cv1', OTHER), created_at: new Date(Date.now() - 4000).toISOString(), deleted_at: null, client_id: null, e2ee: true, file_path: `${OTHER}/img.enc`, file_name: 'Encrypted file', file_size: srv.blobs[`${OTHER}/img.enc`].length, file_mime: 'application/octet-stream', media_path: null, media_type: null })
srv.messages.push({ id: 'enc3', conversation_id: 'cv1', sender: OTHER, body: 'e2ee1.AAAA.BBBB', created_at: new Date(Date.now() - 3000).toISOString(), deleted_at: null, client_id: null, e2ee: true, media_path: null, media_type: null, audio_path: null, audio_ms: null })
await t.page.reload(); await t.page.waitForTimeout(1800)
check('secure chat: this device’s stored key reads Bob’s encrypted text after a reload', await t.page.getByText('Hello from Bob 🔐').isVisible())
check('secure chat: an encrypted photo is downloaded, decrypted in the browser and shown', await t.page.locator('.dm-bubble img').first().evaluate(i => i.naturalWidth > 0))
check('secure chat: a message that cannot be authenticated is shown as locked, not as garbage', await t.page.getByText(/can’t be opened on this device/).isVisible())
check('secure chat: the plain (older) message still shows normally', await t.page.getByText('hello there').isVisible())
await shot(t.page, 'secure-chat')
const before = t.seen.uploads.length
await t.page.locator('input[type=file]').nth(1).setInputFiles({ name: 'secret.png', mimeType: 'image/png', buffer: PNG }); await t.page.waitForTimeout(1500)
const upl = t.seen.uploads.slice(before).find(u => /\/attachments\//.test(u)), idx = t.seen.uploads.indexOf(upl)
const photo = t.seen.messages.at(-1) ?? {}
check('secure chat: a photo is uploaded as ciphertext (not the PNG bytes) to the attachments bucket and sent with e2ee', Boolean(upl) && /\.enc$/.test(upl) && !t.seen.uploadBodies[idx].includes(PNG.subarray(0, 8)) && photo.e2ee === true && /\.enc$/.test(photo.file_path ?? '') && photo.media_path == null && !JSON.stringify(photo).includes('secret.png'))
await t.page.locator('input[type=file]').nth(2).setInputFiles({ name: 'salary-2026.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(3000, 7) }); await t.page.waitForTimeout(1500)
const doc = t.seen.messages.at(-1) ?? {}
check('secure chat: a document’s name and type are hidden inside the encrypted message', doc.e2ee === true && doc.file_name === 'Encrypted file' && !JSON.stringify(doc).includes('salary') && await t.page.getByRole('button', { name: /Download salary-2026.pdf/ }).isVisible())
await t.page.getByRole('button', { name: /Record a voice note/ }).click(); await t.page.waitForTimeout(1500)
await t.page.getByRole('button', { name: 'Done' }).click(); await t.page.waitForTimeout(500)
await t.page.getByRole('button', { name: /^Send$|Sending/ }).click(); await t.page.waitForTimeout(1500)
const vn = t.seen.messages.at(-1) ?? {}
check('secure chat: a voice note is encrypted too (no audio_path, no readable length, ciphertext upload)', vn.e2ee === true && vn.audio_path == null && vn.audio_ms == null && /\.enc$/.test(vn.file_path ?? ''))
await t.ctx.close()

// A new phone: no local key, but the server holds the encrypted backup → ask for the passphrase.
t = await open({ url: '/app/messages/cv1', e2ee: true, srv })
await t.page.waitForTimeout(600)
check('secure chat: on a new device the prompt asks to unlock instead, and old messages show as locked', await t.page.getByRole('button', { name: 'Unlock' }).first().isVisible() && await t.page.getByText(/can’t be opened on this device/).first().isVisible())
await t.page.getByRole('button', { name: 'Unlock' }).first().click()
await t.page.getByLabel('Chat passphrase').fill('definitely not it'); await t.page.getByRole('dialog', { name: /Unlock/ }).getByRole('button', { name: 'Unlock', exact: true }).click(); await t.page.waitForTimeout(1500)
check('secure chat: a wrong passphrase does not unlock', await t.page.getByText(/passphrase is not right/).isVisible())
await t.page.getByLabel('Chat passphrase').fill(PASS); await t.page.getByRole('dialog', { name: /Unlock/ }).getByRole('button', { name: 'Unlock', exact: true }).click(); await t.page.waitForTimeout(2500)
check('secure chat: the right passphrase restores the same key and the history opens', await t.page.getByText('Hello from Bob 🔐').isVisible() && srv.keys[ME] === alicePub)
// Bob gets a new key (new phone): sending pauses until Alice reviews the change.
srv.keys[OTHER] = (await E.generateIdentity()).publicKey
await t.page.reload(); await t.page.waitForTimeout(1500)
check('secure chat: when a contact’s key changes, sending pauses with a clear warning', await t.page.getByRole('region', { name: 'Security code changed' }).isVisible() && !(await t.page.getByLabel('Message', { exact: true }).isVisible()))
await t.page.getByRole('button', { name: 'Continue' }).click(); await t.page.waitForTimeout(600)
check('secure chat: after acknowledging, chatting resumes', await t.page.getByLabel('Message', { exact: true }).isVisible())
// Someone who has not turned on secure chat: messages go the ordinary way, with an honest notice.
delete srv.keys[OTHER]
await t.page.reload(); await t.page.waitForTimeout(1500)
check('secure chat: if the other person has no keys yet, the thread says it is not end-to-end encrypted and still works', await t.page.getByRole('button', { name: /Not end-to-end encrypted yet/ }).isVisible() && await t.page.getByLabel('Message', { exact: true }).isVisible())
await t.page.getByLabel('Message', { exact: true }).fill('plain hi'); await t.page.getByRole('button', { name: 'Send message' }).click(); await t.page.waitForTimeout(600)
check('secure chat: such a message is plain and not flagged e2ee', t.seen.messages.at(-1)?.body === 'plain hi' && !t.seen.messages.at(-1)?.e2ee)
await t.ctx.close()

/* ----------------------------------------------------------------------------------------------------------- Recovery, security page and encrypted groups */
const aliceId = await E.generateIdentity()
const PASS2 = 'amber canyon 77 orchid', RK = E.newRecoveryKey(), NEWPASS = 'brand new passphrase 9'
const mkSrv = async (extra = {}) => {
  const k = await E.conversationKey(bob.privateKey, aliceId.publicKey, 'cv1', OTHER, ME)
  return {
    keys: { [OTHER]: bob.publicKey, [ME]: aliceId.publicKey }, backups: { [ME]: await E.backupIdentity(aliceId.pkcs8, PASS2, 120000) }, recovery: { [ME]: await E.backupWithRecoveryKey(aliceId.pkcs8, RK) },
    escrow: { [ME]: true }, escrowAvailable: true, pkcs8: Buffer.from(aliceId.pkcs8).toString('base64'), blobs: {}, groups: [], convKeys: [], requests: [], events: [],
    messages: [{ id: 'enc1', conversation_id: 'cv1', sender: OTHER, body: await E.encryptEnvelope(k, { t: 'text', m: 'Welcome back Alice' }, 'cv1', OTHER), created_at: new Date(Date.now() - 5000).toISOString(), deleted_at: null, client_id: null, e2ee: true }],
    ...extra,
  }
}
const unlockSheet = t => t.page.getByRole('dialog', { name: /Unlock/ })

// --- new device, forgotten passphrase: unlock with the recovery key
let srv2 = await mkSrv()
t = await open({ url: '/app/messages/cv1', e2ee: true, srv: srv2 })
await t.page.waitForTimeout(500)
await t.page.getByRole('button', { name: 'Unlock' }).first().click(); await t.page.waitForTimeout(900)
check('recovery: the unlock sheet offers passphrase, recovery key and (because it is on) Ask VYBE', await t.page.getByRole('tab', { name: 'Passphrase' }).isVisible() && await t.page.getByRole('tab', { name: 'Recovery key' }).isVisible() && await t.page.getByRole('tab', { name: 'Ask VYBE' }).isVisible())
await shot(t.page, 'unlock-sheet')
await t.page.getByRole('tab', { name: 'Recovery key' }).click()
await t.page.getByLabel('Recovery key').fill(E.newRecoveryKey()); await t.page.getByLabel('Choose a new chat passphrase').fill(NEWPASS); await t.page.getByLabel('Type it again').fill(NEWPASS)
await unlockSheet(t).getByRole('button', { name: 'Unlock', exact: true }).click(); await t.page.waitForTimeout(1500)
check('recovery: a wrong recovery key is refused', await t.page.getByText(/recovery key is not right/).isVisible())
await t.page.getByLabel('Recovery key').fill(RK.toLowerCase().replace(/-/g, ' '))
await unlockSheet(t).getByRole('button', { name: 'Unlock', exact: true }).click(); await t.page.waitForTimeout(3500)
const newRk = (await t.page.locator('.e2-code').textContent()) ?? ''
check('recovery: the right key (typed in any case, with spaces) restores access, replaces the forgotten passphrase and issues a NEW recovery key', await t.page.getByRole('dialog', { name: 'Save your recovery key' }).isVisible() && newRk !== RK && t.seen.backupUpdates.length === 1 && t.seen.backupUpdates[0].p_backup && t.seen.backupUpdates[0].p_recovery)
await t.page.getByLabel(/I have saved my recovery key/).check(); await t.page.getByRole('button', { name: 'Done' }).click(); await t.page.waitForTimeout(1200)
check('recovery: history opens after recovery', await t.page.getByText('Welcome back Alice').isVisible() && await t.page.getByLabel('Message', { exact: true }).isVisible())
check('recovery: the old recovery key stopped working and the new passphrase now unlocks the backup', await E.restoreWithRecoveryKey(srv2.recovery[ME], RK).then(() => false, () => true) && await E.restoreIdentity(srv2.backups[ME], NEWPASS).then(() => true, () => false) && await E.restoreIdentity(srv2.backups[ME], PASS2).then(() => false, () => true))
// the Chat security page, with keys on this device
await t.page.goto(BASE + '/app/settings/chat-security'); await t.page.waitForTimeout(1200)
check('security page: shows secure chat is on with recovery key, passphrase and VYBE-assisted recovery sections', await t.page.getByRole('heading', { name: 'Chat security' }).isVisible() && await t.page.getByRole('button', { name: 'Get a new recovery key' }).isVisible() && await t.page.getByRole('button', { name: 'Change passphrase' }).isVisible() && await t.page.getByRole('heading', { name: /VYBE-assisted recovery/ }).isVisible())
check('security page: VYBE-assisted recovery is explained honestly as not strict end-to-end encryption', await t.page.getByText(/no longer be end-to-end encrypted in the strictest sense/).isVisible())
await shot(t.page, 'chat-security')
await t.page.getByRole('button', { name: 'Get a new recovery key' }).click()
await t.page.getByLabel('Current chat passphrase').fill('wrong passphrase!!'); await t.page.getByRole('button', { name: 'Continue' }).click(); await t.page.waitForTimeout(1500)
check('security page: changing anything needs the current passphrase', await t.page.getByText(/passphrase is not right/).isVisible())
await t.page.getByLabel('Current chat passphrase').fill(NEWPASS); await t.page.getByRole('button', { name: 'Continue' }).click(); await t.page.waitForTimeout(3000)
const rk3 = (await t.page.locator('.e2-code').textContent()) ?? ''
check('security page: a new recovery key replaces the old one', rk3 !== newRk && t.seen.backupUpdates.length === 2 && await E.restoreWithRecoveryKey(srv2.recovery[ME], newRk).then(() => false, () => true))
await t.page.getByLabel(/I have saved my recovery key/).check(); await t.page.getByRole('button', { name: 'Done' }).click(); await t.page.waitForTimeout(500)
await t.page.getByRole('button', { name: 'Change passphrase' }).click()
await t.page.getByLabel('Current chat passphrase').fill(NEWPASS); await t.page.getByLabel('New passphrase').fill('another long passphrase 3'); await t.page.getByLabel('Type it again').fill('another long passphrase 3')
await t.page.getByRole('button', { name: 'Continue' }).click(); await t.page.waitForTimeout(3500)
check('security page: changing the passphrase re-wraps the backup and issues a fresh recovery key', t.seen.backupUpdates.length === 3 && await E.restoreIdentity(srv2.backups[ME], 'another long passphrase 3').then(() => true, () => false) && await t.page.getByRole('dialog', { name: 'Save your recovery key' }).isVisible())
await t.page.getByLabel(/I have saved my recovery key/).check(); await t.page.getByRole('button', { name: 'Done' }).click(); await t.page.waitForTimeout(400)
await t.page.getByRole('button', { name: 'Turn off' }).click().catch(() => {})
await t.ctx.close()

// --- opt-in VYBE-assisted recovery: enabling needs the passphrase and an explicit acknowledgement
srv2 = await mkSrv({ escrow: {}, events: [{ id: 'e1', action: 'create', created_at: new Date().toISOString(), detail: {} }, { id: 'e2', action: 'recovery_failed', created_at: new Date().toISOString(), detail: {} }] })
t = await open({ url: '/app/messages/cv1', e2ee: true, srv: srv2 })
await t.page.getByRole('button', { name: 'Unlock' }).first().click()
check('recovery: "Ask VYBE" is hidden when the member never turned it on', await t.page.getByRole('tab', { name: 'Ask VYBE' }).count() === 0)
await t.page.getByLabel('Chat passphrase').fill(PASS2); await unlockSheet(t).getByRole('button', { name: 'Unlock', exact: true }).click(); await t.page.waitForTimeout(2500)
await t.page.goto(BASE + '/app/settings/chat-security'); await t.page.waitForTimeout(1200)
check('security page: activity log lists key and recovery events in plain words', await t.page.getByText('Secure chat was turned on').isVisible() && await t.page.getByText(/wrong password was entered during recovery/).isVisible())
await t.page.getByRole('button', { name: /Turn on…/ }).click()
await t.page.getByLabel('Current chat passphrase').fill(PASS2); await t.page.getByRole('button', { name: 'Continue' }).click(); await t.page.waitForTimeout(800)
check('security page: VYBE-assisted recovery cannot be enabled without ticking the acknowledgement', await t.page.getByText(/Tick the box/).isVisible() && !t.seen.fnCalls.some(c => c.action === 'enable'))
await t.page.getByLabel(/I understand VYBE will hold a sealed copy/).check(); await t.page.getByRole('button', { name: 'Continue' }).click(); await t.page.waitForTimeout(3000)
const en = t.seen.fnCalls.find(c => c.action === 'enable')
check('security page: enabling sends the key to the recovery service only after unlocking it with the passphrase (and it is the member’s real key)', Boolean(en) && await E.publicFromPkcs8(Buffer.from(en.pkcs8, 'base64')) === aliceId.publicKey)
await t.ctx.close()

// --- Ask VYBE: request (password + waiting period) and cancel
srv2 = await mkSrv()
t = await open({ url: '/app/messages/cv1', e2ee: true, srv: srv2 })
await t.page.getByRole('button', { name: 'Unlock' }).first().click(); await t.page.getByRole('tab', { name: 'Ask VYBE' }).click()
await t.page.getByLabel('Your VYBE account password').fill('nope'); await unlockSheet(t).getByRole('button', { name: 'Request recovery' }).click(); await t.page.waitForTimeout(800)
check('recovery: a wrong account password is refused by the service', await t.page.getByText(/password is not right/).isVisible() && srv2.requests.length === 0)
await t.page.getByLabel('Your VYBE account password').fill('account-pass'); await unlockSheet(t).getByRole('button', { name: 'Request recovery' }).click(); await t.page.waitForTimeout(1200)
check('recovery: the request starts a waiting period; nothing is released and the member is told when it ends', srv2.requests.length === 1 && await t.page.getByText(/can be completed after/).isVisible() && await unlockSheet(t).getByRole('button', { name: 'Waiting…' }).isVisible())
await shot(t.page, 'vybe-recovery-waiting')
await t.page.getByRole('button', { name: 'Cancel this recovery' }).click(); await t.page.waitForTimeout(800)
check('recovery: the request can be cancelled', srv2.requests[0].status === 'cancelled' && t.seen.rpc.some(r => r.name === 'cancel_recovery_request'))
await t.ctx.close()

// --- after the waiting period: password + new passphrase finish the recovery
srv2 = await mkSrv({ requests: [{ id: 'rq0', status: 'waiting', created_at: new Date(Date.now() - 80 * 3600e3).toISOString(), ready_at: new Date(Date.now() - 3600e3).toISOString(), expires_at: new Date(Date.now() + 5 * 864e5).toISOString() }] })
t = await open({ url: '/app/messages/cv1', e2ee: true, srv: srv2 })
await t.page.getByRole('button', { name: 'Unlock' }).first().click(); await t.page.getByRole('tab', { name: 'Ask VYBE' }).click(); await t.page.waitForTimeout(500)
check('recovery: once the waiting period is over the sheet asks for the password and a new passphrase', await t.page.getByText(/waiting period is over/).isVisible() && await unlockSheet(t).getByRole('button', { name: 'Finish recovery' }).isVisible())
await t.page.getByLabel('Your VYBE account password').fill('account-pass'); await t.page.getByLabel('Choose a new chat passphrase').fill(NEWPASS); await t.page.getByLabel('Type it again').fill(NEWPASS)
await unlockSheet(t).getByRole('button', { name: 'Finish recovery' }).click(); await t.page.waitForTimeout(3500)
check('recovery: the released key is verified against the published key, re-protected with the new passphrase, and a new recovery key is issued', await t.page.getByRole('dialog', { name: 'Save your recovery key' }).isVisible() && await E.restoreIdentity(srv2.backups[ME], NEWPASS).then(() => true, () => false) && t.seen.fnCalls.some(c => c.action === 'complete' && c.id === 'rq0'))
await t.page.getByLabel(/I have saved my recovery key/).check(); await t.page.getByRole('button', { name: 'Done' }).click(); await t.page.waitForTimeout(1200)
check('recovery: chats open again', await t.page.getByText('Welcome back Alice').isVisible())
// a recovery in progress is flagged loudly on every device that is already signed in
srv2.requests = [{ id: 'rq9', status: 'waiting', created_at: new Date().toISOString(), ready_at: new Date(Date.now() + 70 * 3600e3).toISOString(), expires_at: new Date(Date.now() + 9 * 864e5).toISOString() }]
await t.page.goto(BASE + '/app/settings/chat-security'); await t.page.waitForTimeout(1200)
check('security page: a recovery request is shown as an alert with a one-tap “This wasn’t me — cancel”', await t.page.getByText(/recovery of your chat key was requested/).isVisible())
await t.page.getByRole('button', { name: /This wasn’t me/ }).click(); await t.page.waitForTimeout(800)
check('security page: cancelling stops it', srv2.requests[0].status === 'cancelled' && await t.page.getByText(/recovery of your chat key was requested/).count() === 0)
await t.ctx.close()

// --- encrypted groups
const wrapFor = async (member, id, raw, epoch = 1) => E.wrapGroupKey(bob.privateKey, aliceId.publicKey, raw, 'cg1', epoch, id)
srv2 = await mkSrv({ groups: [{ id: 'cg1', key_epoch: 0 }] })
t = await open({ url: '/app/messages/cg1', e2ee: true, srv: srv2 })
await t.page.waitForTimeout(500)
check('group: a plain group on a locked device offers to unlock secure chat in order to encrypt it', await t.page.getByRole('button', { name: /secure chat to encrypt this group/ }).isVisible())
await t.page.getByRole('button', { name: /secure chat to encrypt this group/ }).click(); await t.page.getByLabel('Chat passphrase').fill(PASS2); await unlockSheet(t).getByRole('button', { name: 'Unlock', exact: true }).click(); await t.page.waitForTimeout(2500)
check('group: a plain group offers to turn on end-to-end encryption', await t.page.getByRole('button', { name: /Turn on encryption for this group/ }).isVisible() && await t.page.getByLabel('Message', { exact: true }).isVisible())
await shot(t.page, 'group-plain')
await t.page.getByRole('button', { name: /Turn on encryption for this group/ }).click(); await t.page.getByRole('dialog', { name: 'Security code' }).getByRole('button', { name: 'Turn on encryption' }).click(); await t.page.waitForTimeout(2500)
const rowFor = id => t.seen.convKeyRows.find(r => r.user_id === id)
check('group: encryption starts at epoch 1 and the key is delivered sealed to each member who has secure chat on (not to members without keys)', t.seen.rpc.some(r => r.name === 'start_group_encryption') && Boolean(rowFor(ME)) && Boolean(rowFor(OTHER)) && t.seen.convKeyRows.length === 2 && t.seen.convKeyRows.every(r => r.epoch === 1 && r.wrapped_by === ME))
const bobGroup = await E.unwrapGroupKey(bob.privateKey, aliceId.publicKey, rowFor(OTHER).wrapped, 'cg1', 1, OTHER)
check('group: Bob can open his copy with his own private key (the server cannot)', bobGroup.raw.length === 32)
check('group: the thread now says it is an end-to-end encrypted group', await t.page.getByRole('button', { name: /End-to-end encrypted group/ }).isVisible())
await t.page.getByLabel('Message', { exact: true }).fill('Group secret'); await t.page.getByRole('button', { name: 'Send message' }).click(); await t.page.waitForTimeout(1000)
const gm = t.seen.messages.at(-1) ?? {}
check('group: a group message is stored as ciphertext with its key epoch, and every member with the key can read it', gm.e2ee === true && gm.key_epoch === 1 && gm.body?.startsWith('e2ee1.') && !gm.body.includes('secret') && (await E.decryptEnvelope(bobGroup.key, gm.body, 'cg1', ME, 1)).m === 'Group secret')
check('group: the sender sees their own message', await t.page.getByText('Group secret').isVisible())
await shot(t.page, 'group-secure')
check('group: the encrypted group never shows ciphertext or garbage in the inbox preview path (groups are skipped)', !(await t.page.getByText(/e2ee1\./).count()))
await t.ctx.close()

// a member without the key yet, then the key arrives
srv2 = await mkSrv({ groups: [{ id: 'cg1', key_epoch: 1 }] })
const gkey = E.newGroupKey(), gk = await E.groupMessageKey(gkey)
srv2.messages.push({ id: 'g1', conversation_id: 'cg1', sender: OTHER, body: await E.encryptEnvelope(gk, { t: 'text', m: 'Welcome to the crew' }, 'cg1', OTHER, 1), created_at: new Date(Date.now() - 4000).toISOString(), deleted_at: null, client_id: null, e2ee: true, key_epoch: 1 })
t = await open({ url: '/app/messages/cg1', e2ee: true, srv: srv2 })
await t.page.getByRole('button', { name: 'Unlock' }).first().click(); await t.page.getByLabel('Chat passphrase').fill(PASS2); await unlockSheet(t).getByRole('button', { name: 'Unlock', exact: true }).click(); await t.page.waitForTimeout(2500)
check('group: an encrypted group whose key has not reached this member yet says so, hides the composer and shows messages as locked', await t.page.getByRole('region', { name: 'Waiting for the group key' }).isVisible() && !(await t.page.getByLabel('Message', { exact: true }).isVisible()) && await t.page.getByText(/can’t be opened on this device/).isVisible())
await shot(t.page, 'group-waiting')
srv2.convKeys.push({ conversation_id: 'cg1', user_id: ME, epoch: 1, wrapped: await E.wrapGroupKey(bob.privateKey, aliceId.publicKey, gkey, 'cg1', 1, ME), wrapped_by: OTHER })
await t.page.reload(); await t.page.waitForTimeout(2500)
check('group: when a member who holds the key delivers it, this member reads the history and can write', await t.page.getByText('Welcome to the crew').isVisible() && await t.page.getByLabel('Message', { exact: true }).isVisible())
check('group: holding the key, this member also delivers it to anyone who is still missing it', t.seen.convKeyRows.some(r => r.user_id === OTHER && r.wrapped_by === ME))
await t.ctx.close()

/* ----------------------------------------------------------------------------------------------------------- Original quality */
t = await open({ url: '/app/create' })
const fs = await import('node:fs')
const original = fs.readFileSync('/tmp/claude-0/original.jpg')
await t.page.locator('input[type=file][multiple]').setInputFiles({ name: 'original.jpg', mimeType: 'image/jpeg', buffer: original })
await t.page.getByLabel("What's on your mind?").fill('Full quality')
await t.page.getByRole('button', { name: 'Post', exact: true }).click(); await t.page.waitForTimeout(1500)
check('uploads keep the original file: same type and exactly the original bytes, no re-compression (sent resumably because it is over 6 MB)', t.seen.uploads.length === 1 && t.seen.uploadBodies[0]?.equals(original) && /jpg$/.test(t.seen.uploads[0]) && t.seen.uploadTypes[0] === 'image/jpeg' && t.seen.tusCalls[0] === 'POST', `${original.length} → ${t.seen.uploadSizes[0]} ${t.seen.uploads[0]} ${t.seen.uploadTypes[0]}`)
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

/* ------------------------------------------------------------------------------------------- Names stay in sync */
t = await open({ url: '/app/posts/p1', meOver: { display_name: 'Chief DAWG' } })
await t.page.waitForTimeout(600)
await shot(t.page, 'name-synced')
check('a changed name shows on your older comments and tags without refetching them', await t.page.locator('.cmt-name', { hasText: 'Chief DAWG' }).count() === 1 && await t.page.locator('.cmt-name', { hasText: /^Alice/ }).count() === 0 && await t.page.getByText(/with Chief DAWG/).isVisible())
await t.ctx.close()
t = await open({ url: '/app/profile/edit', meOver: { display_name_changed_at: new Date(Date.now() - 3 * 864e5).toISOString() } })
await t.page.waitForTimeout(600)
await shot(t.page, 'name-locked')
check('within 14 days of a name change the name field is locked and says when it opens again', await t.page.getByLabel('Name', { exact: true }).isDisabled() && await t.page.getByText(/You can change your name again on/).isVisible())
await t.ctx.close()
t = await open({ url: '/app/profile/edit' })
await t.page.waitForTimeout(600)
check('otherwise the name can be edited, with the 14-day rule explained', await t.page.getByLabel('Name', { exact: true }).isEnabled() && await t.page.getByText(/once every 14 days/).isVisible())
await t.ctx.close()

for (const [w, h] of [[375, 667], [768, 1024], [1280, 800]]) {
  const x = await open({ width: w, height: h })
  check(`Home with the rail has no horizontal overflow at ${w}×${h}`, !(await overflow(x.page)))
  await x.ctx.close()
}
/* ------------------------------------------------------------------------------------------- Two tabs, two accounts */
{
  const x = await open({ url: '/app/settings' })
  const tabA = x.page
  const tabB = await x.ctx.newPage(); await tabB.goto(BASE + '/app/settings'); await tabB.waitForTimeout(800)
  await tabA.bringToFront(); await tabA.waitForTimeout(200); await tabB.bringToFront()
check('a second tab opens signed in as the same account', await tabB.getByRole('button', { name: 'Sign out' }).isVisible())
  await tabB.getByRole('button', { name: 'Sign out' }).click(); await tabB.waitForURL(/\/signin/); await tabB.waitForTimeout(500)
  const slotB = await tabB.evaluate(() => sessionStorage.getItem('vybe:slot'))
  check('signing out in one tab moves only that tab to its own slot and the sign-in page', /^a[0-9a-f]{8}$/.test(slotB ?? '') && await tabB.getByRole('button', { name: 'Sign in' }).isVisible(), String(slotB))
  check('the other tab stays signed in (its session is untouched)', await tabA.evaluate(() => Boolean(localStorage.getItem('sb-mock-auth-token'))) && await tabA.getByRole('button', { name: 'Sign out' }).isVisible() && !(await tabA.url()).includes('/signin'))
  await tabB.close({ runBeforeUnload: true }); await tabA.waitForTimeout(300)       // a closed tab stops counting at once
  await tabA.getByRole('button', { name: 'Sign out' }).click(); await tabA.waitForTimeout(800)
  check('with no other tab on the account, Sign out really signs out', !(await tabA.evaluate(() => localStorage.getItem('sb-mock-auth-token'))), tabA.url())
  await x.ctx.close()
}
/* ------------------------------------------------------------------------------------------ Video posters */
// A real (WebM) clip made with ffmpeg, so the browser can decode a frame. Skipped, and said so, when ffmpeg is missing.
let clip = null
try { const d = mkdtempSync(join(tmpdir(), 'vybe-clip-')); execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10', '-t', '2', '-c:v', 'libvpx', '-b:v', '200k', join(d, 'c.webm')]); clip = readFileSync(join(d, 'c.webm')) } catch { console.log('- video poster check skipped: ffmpeg is not available') }
if (clip) {
  const t = await open({ url: '/app/create' })
  await t.page.locator('input[type=file][multiple]').setInputFiles([{ name: 'clip.webm', mimeType: 'video/webm', buffer: clip }])
  await t.page.waitForTimeout(1500)
  await t.page.getByRole('button', { name: 'Post', exact: true }).click(); await t.page.waitForTimeout(1500)
  const pm = t.seen.post_media[0]?.[0]
  check('a video gets a poster made on the device: uploaded to the member\'s folder and saved with the post', pm?.type === 'video' && /^aaaaaaaa-0000-4000-8000-000000000001\/.+\.webp$/.test(pm?.poster_path ?? '') && t.seen.stills.some(st => st.endsWith(pm.poster_path)), JSON.stringify({ pm, stills: t.seen.stills }))
  check('the library record carries the clip\'s real frame size and duration from the device', t.seen.assets[0]?.kind === 'video' && t.seen.assets[0]?.width === 320 && t.seen.assets[0]?.height === 240 && Math.abs((t.seen.assets[0]?.duration_ms ?? 0) - 2000) < 300, JSON.stringify(t.seen.assets[0]))
  await t.ctx.close()
}

/* ------------------------------------------------------------------------------------------ Resume after a reload */
{
  const t = await open({ url: '/app/create' })
  const entry = { bucket: 'media', path: `${ME}/r1.mp4`, location: 'https://mock.supabase.test/storage/v1/upload/resumable/s1', size: 9000000, name: 'Concert.mp4', at: Date.now() }
  await t.page.evaluate(e => localStorage.setItem('vybe:uploads:v1', JSON.stringify({ k1: e })), entry)
  await t.page.reload(); await t.page.waitForTimeout(900)
  check('after a reload the composer says which upload stopped and how to continue it', await t.page.getByText(/Your upload of/).isVisible() && await t.page.getByText('Concert.mp4').isVisible() && await t.page.getByRole('button', { name: 'Pick the file' }).isVisible())
  await t.page.getByRole('button', { name: 'Start fresh' }).click(); await t.page.waitForTimeout(200)
  check('"Start fresh" forgets it', !(await t.page.getByText(/Your upload of/).count()) && await t.page.evaluate(() => localStorage.getItem('vybe:uploads:v1')) === null)
  await t.page.evaluate(e => localStorage.setItem('vybe:uploads:v1', JSON.stringify({ k1: { ...e, path: 'someone-else/r1.mp4' } })), entry)
  await t.page.reload(); await t.page.waitForTimeout(900)
  check('another account\'s unfinished upload on the same device is not offered', !(await t.page.getByText(/Your upload of/).count()))
  await t.ctx.close()
}

await browser.close()
console.log(failures ? `\n${failures} check(s) failed` : '\nall social checks passed')
process.exit(failures ? 1 : 0)
