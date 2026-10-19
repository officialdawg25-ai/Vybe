import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
// Accepts the newer "publishable" key or the legacy "anon" key; both are public, browser-safe keys.
const key = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || import.meta.env.VITE_SUPABASE_ANON_KEY) as string | undefined

/** False when the build has no Supabase credentials; the UI then shows a setup notice. */
export const configured = Boolean(url && key)

// Placeholder values keep module import safe when unconfigured; no request is ever made then.
export const supabase = createClient(url || 'http://localhost', key || 'unconfigured', {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
})
