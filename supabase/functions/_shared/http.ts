/** Plumbing shared by every edge function. Pure TypeScript (no Deno globals) so Node/Vitest can drive the handlers too. */
export type Env = Record<string, string | undefined>
export interface Deps { env: Env; fetch: typeof fetch; now?: () => number }

export const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
  'access-control-allow-methods': 'POST, OPTIONS',
}
export const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS, ...extra } })
export const text = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' } })
export const preflight = (req: Request) => (req.method === 'OPTIONS' ? new Response(null, { status: 204, headers: CORS }) : null)

export const need = (env: Env, ...keys: string[]) => keys.filter(k => !env[k])

/** Calls PostgREST with the SERVICE ROLE key. Only for work no browser role may do (fulfilling orders, webhooks). */
export const service = (deps: Deps) => ({
  rest: (path: string, init: RequestInit = {}) => deps.fetch(`${deps.env.SUPABASE_URL}${path}`, { ...init, headers: { apikey: deps.env.SUPABASE_SERVICE_ROLE_KEY!, authorization: `Bearer ${deps.env.SUPABASE_SERVICE_ROLE_KEY}`, 'content-type': 'application/json', ...(init.headers ?? {}) } }),
  rpc(fn: string, args: Record<string, unknown>) { return this.rest(`/rest/v1/rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) }) },
})

/** Calls PostgREST AS THE USER (their JWT), so Row Level Security and auth.uid() apply exactly as in the app. */
export const asUser = (deps: Deps, token: string) => ({
  rest: (path: string, init: RequestInit = {}) => deps.fetch(`${deps.env.SUPABASE_URL}${path}`, { ...init, headers: { apikey: deps.env.SUPABASE_ANON_KEY ?? deps.env.SUPABASE_SERVICE_ROLE_KEY!, authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers ?? {}) } }),
  rpc(fn: string, args: Record<string, unknown>) { return this.rest(`/rest/v1/rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) }) },
})

export const bearer = (req: Request) => (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')

export interface Caller { id: string; email: string; name: string; token: string }
/** Verifies the caller's access token with Supabase Auth and returns who they are. */
export async function whoami(deps: Deps, req: Request): Promise<Caller | null> {
  const token = bearer(req)
  if (!token) return null
  const r = await deps.fetch(`${deps.env.SUPABASE_URL}/auth/v1/user`, { headers: { apikey: deps.env.SUPABASE_ANON_KEY ?? deps.env.SUPABASE_SERVICE_ROLE_KEY!, authorization: `Bearer ${token}` } })
  if (!r.ok) return null
  const u = (await r.json()) as { id?: string; email?: string; user_metadata?: { display_name?: string; username?: string } }
  return u.id ? { id: u.id, email: u.email ?? '', name: u.user_metadata?.display_name || u.user_metadata?.username || 'VYBE member', token } : null
}

/** Turns a PostgREST error body into a message safe to show people. */
export async function dbError(r: Response, fallback = 'Something went wrong.'): Promise<string> {
  const b = (await r.json().catch(() => ({}))) as { message?: string }
  return b.message && !/^(JWT|permission denied|new row|duplicate key)/i.test(b.message) ? b.message : fallback
}

export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
}

export const clientIp = (req: Request) => (req.headers.get('cf-connecting-ip') ?? req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim()
