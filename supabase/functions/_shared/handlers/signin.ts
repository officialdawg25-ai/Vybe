// username-signin: sign in with a username instead of an email address.
// The browser never learns which email belongs to a username: this function looks the account up with the service role,
// asks Supabase Auth to check the password (the normal password grant), and returns only the session it issues.
// Every attempt is recorded per hashed IP and per username; after too many failures it answers "try again later" without
// checking the password, so it cannot be used to guess passwords faster than the normal sign-in. Wrong username and
// wrong password give the same answer.
import { clientIp, json, preflight, service, sha256Hex, type Deps } from '../http.ts'

export const LIMITS = { perIp: 20, perUser: 8, windowMin: 15 }
const SAME = 'That username and password don’t match an account.'

export async function handleUsernameSignin(req: Request, deps: Deps): Promise<Response> {
  const pre = preflight(req); if (pre) return pre
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)
  const b = (await req.json().catch(() => ({}))) as { username?: string; password?: string }
  const username = String(b.username ?? '').trim().toLowerCase().replace(/^@/, '')
  const password = String(b.password ?? '')
  if (!/^[a-z0-9_]{3,30}$/.test(username) || password.length < 1 || password.length > 200) return json({ error: SAME }, 400)

  const svc = service(deps)
  const ipHash = await sha256Hex(`${clientIp(req) || 'unknown'}|${deps.env.SUPABASE_URL}`)
  const since = new Date((deps.now?.() ?? Date.now()) - LIMITS.windowMin * 60_000).toISOString()
  const count = async (col: 'ip_hash' | 'username', v: string) => {
    const r = await svc.rest(`/rest/v1/login_attempts?select=id&${col}=eq.${encodeURIComponent(v)}&ok=is.false&at=gte.${encodeURIComponent(since)}`, { headers: { prefer: 'count=exact', range: '0-0' } })
    return Number((r.headers.get('content-range') ?? '').split('/')[1] ?? 0) || 0
  }
  const [byIp, byUser] = await Promise.all([count('ip_hash', ipHash), count('username', username)])
  if (byIp >= LIMITS.perIp || byUser >= LIMITS.perUser) return json({ error: 'Too many attempts. Wait a few minutes, or sign in with your email.' }, 429)
  const record = (ok: boolean) => svc.rest('/rest/v1/login_attempts', { method: 'POST', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ ip_hash: ipHash, username, ok }) }).catch(() => null)

  const p = await svc.rest(`/rest/v1/profiles?select=id&username=eq.${encodeURIComponent(username)}&limit=1`)
  const id = p.ok ? ((await p.json()) as { id: string }[])[0]?.id : undefined
  let email: string | undefined
  if (id) {
    const u = await deps.fetch(`${deps.env.SUPABASE_URL}/auth/v1/admin/users/${id}`, { headers: { apikey: deps.env.SUPABASE_SERVICE_ROLE_KEY!, authorization: `Bearer ${deps.env.SUPABASE_SERVICE_ROLE_KEY}` } })
    if (u.ok) email = ((await u.json()) as { email?: string }).email || undefined
  }
  if (!email) { await record(false); return json({ error: SAME }, 400) }

  const t = await deps.fetch(`${deps.env.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: deps.env.SUPABASE_ANON_KEY || deps.env.SUPABASE_SERVICE_ROLE_KEY!, 'content-type': 'application/json' }, body: JSON.stringify({ email, password }),
  })
  const body = (await t.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; error_code?: string; msg?: string; error_description?: string }
  if (!t.ok || !body.access_token || !body.refresh_token) {
    await record(false)
    if (body.error_code === 'email_not_confirmed') return json({ error: 'Confirm your email first: open the link we sent when you joined.' }, 400)
    return json({ error: SAME }, 400)
  }
  await record(true)
  return json({ access_token: body.access_token, refresh_token: body.refresh_token })
}
