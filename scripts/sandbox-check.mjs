// Verifies your gateway + LiveKit credentials from YOUR machine (this repo's CI sandbox cannot reach them).
//   node --experimental-strip-types scripts/sandbox-check.mjs payfast   # PayFast sandbox: is our signed checkout accepted?
//   node --experimental-strip-types scripts/sandbox-check.mjs livekit    # LiveKit: do the key/secret/url work (lists rooms)?
//   node --experimental-strip-types scripts/sandbox-check.mjs ozow       # Ozow: prints a signed test payload to post at pay.ozow.com
// Reads LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET, PAYFAST_MERCHANT_ID/KEY/PASSPHRASE, OZOW_SITE_CODE/PRIVATE_KEY from the environment.
// PayFast falls back to PayFast's public sandbox test merchant when nothing is set. Nothing here touches a live account.
import { payfastCheckout, ozowCheckout } from '../supabase/functions/_shared/payments.ts'
import { roomService, signToken } from '../supabase/functions/_shared/livekit.ts'

const what = process.argv[2]
const env = { APP_ORIGIN: 'https://example.test', SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'x', PAYFAST_SANDBOX: '1', OZOW_IS_TEST: '1', ...process.env }
const order = { id: crypto.randomUUID(), buyer: 'b', event_id: 'e', status: 'pending', provider: 'payfast', total_cents: 1000, expires_at: new Date(Date.now() + 9e5).toISOString() }

if (what === 'payfast') {
  const e = { ...env, PAYFAST_MERCHANT_ID: env.PAYFAST_MERCHANT_ID ?? '10000100', PAYFAST_MERCHANT_KEY: env.PAYFAST_MERCHANT_KEY ?? '46f0cd694581a' }
  const c = payfastCheckout(e, order, { email: 'sandbox-buyer@example.com', name: 'Sandbox Buyer' }, 'VYBE sandbox check')
  const r = await fetch(c.action, { method: 'POST', body: new URLSearchParams(c.fields), redirect: 'manual' })
  const html = await r.text()
  const bad = /signature (does not match|mismatch)|Generated signature|invalid/i.test(html)
  console.log(`PayFast sandbox responded ${r.status}. ${bad ? '✗ Signature rejected: check PAYFAST_PASSPHRASE matches the sandbox account.' : '✓ Checkout accepted (signature valid).'}`)
  process.exit(bad ? 1 : 0)
} else if (what === 'livekit') {
  for (const k of ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET']) if (!env[k]) { console.error(`Set ${k}`); process.exit(2) }
  const r = await roomService({ env, fetch }, 'ListRooms', {})
  const body = await r.text()
  console.log(r.ok ? `✓ LiveKit accepted the key and secret. Rooms: ${body.slice(0, 120)}` : `✗ LiveKit said ${r.status}: ${body.slice(0, 200)}`)
  const t = await signToken({ apiKey: env.LIVEKIT_API_KEY, secret: env.LIVEKIT_API_SECRET, identity: 'check', video: { room: 'check', roomJoin: true } })
  console.log(`Sample viewer token (valid 2 h): ${t.slice(0, 40)}…`)
  process.exit(r.ok ? 0 : 1)
} else if (what === 'ozow') {
  for (const k of ['OZOW_SITE_CODE', 'OZOW_PRIVATE_KEY']) if (!env[k]) { console.error(`Set ${k}`); process.exit(2) }
  const c = await ozowCheckout(env, { ...order, provider: 'ozow' }, { email: 'sandbox-buyer@example.com' })
  console.log(`POST ${c.action}\n${Object.entries(c.fields).map(([k, v]) => `  ${k}=${v}`).join('\n')}\nSubmit this form in a browser with Ozow test mode on (IsTest=true) to complete a test payment.`)
} else { console.error('usage: sandbox-check.mjs payfast | livekit | ozow'); process.exit(2) }
