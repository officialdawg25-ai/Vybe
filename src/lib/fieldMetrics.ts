import { configured, supabase, supabaseKey, supabaseUrl } from './supabase'
import { startFieldMetrics } from './metrics'

/**
 * Sends sampled performance numbers (lib/metrics.ts) to record_client_metrics. A plain fetch with keepalive, because the
 * last batch leaves while the page is closing, when supabase-js requests would be cancelled. Signed-out visits send nothing.
 */
let token: string | null = null
if (configured) {
  supabase.auth.onAuthStateChange((_e, s) => { token = s?.access_token ?? null })
  startFieldMetrics(batch => {
    if (!token) return
    void fetch(`${supabaseUrl}/rest/v1/rpc/record_client_metrics`, {
      method: 'POST', keepalive: true,
      headers: { apikey: supabaseKey, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ samples: batch }),
    }).catch(() => { /* best effort: a lost batch is only a lost sample */ })
  })
}
