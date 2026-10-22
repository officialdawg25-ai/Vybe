import { describe, expect, it } from 'vitest'
import { LIMITS, handleUsernameSignin } from '../../supabase/functions/_shared/handlers/signin.ts'
import type { Deps } from '../../supabase/functions/_shared/http.ts'

const UID = 'aaaaaaaa-0000-4000-8000-000000000001'
function world(o: { failures?: number; userFailures?: number; password?: string; confirmed?: boolean } = {}) {
  const calls: { url: string; method: string; body: string }[] = []
  const f = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input), body = typeof init.body === 'string' ? init.body : ''
    calls.push({ url, method: init.method ?? 'GET', body })
    if (url.includes('/rest/v1/login_attempts?select')) return new Response('[]', { headers: { 'content-range': `0-0/${url.includes('ip_hash') ? o.failures ?? 0 : o.userFailures ?? 0}` } })
    if (url.includes('/rest/v1/login_attempts')) return new Response(null, { status: 201 })
    if (url.includes('/rest/v1/profiles')) return new Response(url.includes('username=eq.alice') ? JSON.stringify([{ id: UID }]) : '[]')
    if (url.includes(`/auth/v1/admin/users/${UID}`)) return new Response(JSON.stringify({ email: 'alice@example.com' }))
    if (url.includes('/auth/v1/token')) {
      const b = JSON.parse(body)
      if (o.confirmed === false) return new Response(JSON.stringify({ error_code: 'email_not_confirmed' }), { status: 400 })
      return b.email === 'alice@example.com' && b.password === (o.password ?? 'right-pass') ? new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt' })) : new Response(JSON.stringify({ error_code: 'invalid_credentials' }), { status: 400 })
    }
    return new Response('{}', { status: 404 })
  }) as typeof fetch
  const deps: Deps = { env: { SUPABASE_URL: 'https://p.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'svc', SUPABASE_ANON_KEY: 'anon' }, fetch: f }
  const call = (username: string, password: string) => handleUsernameSignin(new Request('https://x/username-signin', { method: 'POST', headers: { 'cf-connecting-ip': '1.2.3.4' }, body: JSON.stringify({ username, password }) }), deps)
  return { call, calls }
}

describe('username sign-in', () => {
  it('signs in with a username and returns only the session (never the email)', async () => {
    const w = world()
    const r = await w.call('@Alice', 'right-pass')
    const b = await r.json()
    expect(r.status).toBe(200)
    expect(b).toEqual({ access_token: 'at', refresh_token: 'rt' })
    expect(JSON.stringify(b)).not.toContain('example.com')
    expect(w.calls.some(c => c.url.includes('/rest/v1/login_attempts') && c.method === 'POST' && JSON.parse(c.body).ok === true)).toBe(true)
  })
  it('a wrong password and an unknown username get the same answer, and both are recorded', async () => {
    const a = await (await world().call('alice', 'nope')).json()
    const w = world(); const b = await (await w.call('nobody_here', 'nope')).json()
    expect(a.error).toBe(b.error)
    expect(w.calls.some(c => c.method === 'POST' && c.url.includes('login_attempts') && JSON.parse(c.body).ok === false)).toBe(true)
    expect(w.calls.some(c => c.url.includes('/auth/v1/token'))).toBe(false)     // no password check for an unknown name
  })
  it('stops checking passwords after too many failures from one place or for one account', async () => {
    for (const w of [world({ failures: LIMITS.perIp }), world({ userFailures: LIMITS.perUser })]) {
      const r = await w.call('alice', 'right-pass')
      expect(r.status).toBe(429)
      expect(w.calls.some(c => c.url.includes('/auth/v1/token'))).toBe(false)
    }
  })
  it('stores a hash of the IP, not the IP', async () => {
    const w = world(); await w.call('alice', 'x')
    const rec = w.calls.find(c => c.method === 'POST' && c.url.includes('login_attempts'))!
    expect(rec.body).not.toContain('1.2.3.4'); expect(JSON.parse(rec.body).ip_hash).toMatch(/^[0-9a-f]{64}$/)
  })
  it('tells an unconfirmed account to confirm its email; rejects malformed input', async () => {
    expect((await (await world({ confirmed: false }).call('alice', 'right-pass')).json()).error).toMatch(/Confirm your email/)
    expect((await world().call('a b', 'x')).status).toBe(400)
  })
})
