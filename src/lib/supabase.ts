import { createClient } from '@supabase/supabase-js'
import { slotStorageKey } from './slot'

// Public, browser-safe defaults for this project, so a build made without the variables (e.g. Cloudflare's own git build) still connects.
// A publishable key only identifies the project; Row Level Security is what protects the data. Build variables override these.
const DEFAULT_URL = 'https://ukgtcungmisthtmknxni.supabase.co'
const DEFAULT_KEY = 'sb_publishable_PjmHkiza5aamh6Nq94E8wg_OTGWmCPf'
const url = (import.meta.env.VITE_SUPABASE_URL || DEFAULT_URL) as string | undefined
// Accepts the newer "publishable" key or the legacy "anon" key; both are public, browser-safe keys.
const key = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || import.meta.env.VITE_SUPABASE_ANON_KEY || DEFAULT_KEY) as string | undefined

/** Project URL and public key, for the few raw HTTP calls supabase-js cannot make (upload progress, resumable uploads). */
export const supabaseUrl = url || 'http://localhost'
export const supabaseKey = key || 'unconfigured'

/** False when the build has no Supabase credentials; the UI then shows a setup notice. */
export const configured = Boolean(url && key)

/** Names exactly what the build is missing, so a misconfigured deploy is diagnosable from the page. */
export const configProblem = (): string => {
  const missing = [!url && 'VITE_SUPABASE_URL', !key && 'VITE_SUPABASE_PUBLISHABLE_KEY (or VITE_SUPABASE_ANON_KEY)'].filter(Boolean)
  return `VYBE isn't connected to its backend. This build is missing: ${missing.join(' and ')}. Set it as a build variable and redeploy.`
}

const extraKey = slotStorageKey(new URL(url || 'http://localhost').hostname.split('.')[0])

// Placeholder values keep module import safe when unconfigured; no request is ever made then.
export const supabase = createClient(url || 'http://localhost', key || 'unconfigured', {
  // storageKey is only passed for extra accounts: an explicit `undefined` would replace Supabase's default key and sign everyone out.
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, ...(extraKey ? { storageKey: extraKey } : {}) },
})
