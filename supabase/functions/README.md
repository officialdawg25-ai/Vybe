# Edge Functions

All server-side work (payments, refunds, live streaming, payout accounts) runs as Supabase Edge Functions so every secret lives
in one place: **Dashboard → Edge Functions → Secrets** (or `supabase secrets set NAME=value`). Logic is in `_shared/` (plain
TypeScript, unit-tested in Node); each `*/index.ts` is a three-line Deno entry point.

| Function | Who calls it | JWT | Purpose |
| --- | --- | --- | --- |
| `pay-start` | signed-in buyer | yes | signed PayFast / Ozow checkout for the buyer's pending order |
| `payfast-itn` | PayFast | **no** (signature) | verifies the notification and fulfils the order |
| `ozow-notify` | Ozow | **no** (hash) | same for Ozow |
| `refund-process` | buyer / organizer / admin | yes | pushes an *approved* refund to the gateway (PayFast cards) or flags it for manual completion |
| `livekit-token` | signed-in viewer / host | yes | asks the database whether the caller may watch/broadcast, then mints a LiveKit token |
| `livekit-control` | stream host | yes | end the stream, remove a viewer |
| `livekit-webhook` | LiveKit | **no** (signed JWT) | room started/finished, viewer counts |
| `maps` | signed-in members | yes | Google Places search, route estimates and static map previews; rate-limited per member in Postgres (`maps_gate`) |
| `payout-account` | org owner/admin, admin | yes | stores bank details AES-256-GCM-encrypted; admin-only audited reveal |

## Secrets

`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are provided automatically. You set:

```
APP_ORIGIN=https://vybe.officialdawg25.workers.dev
LIVEKIT_URL=wss://<project>.livekit.cloud     LIVEKIT_API_KEY=...     LIVEKIT_API_SECRET=...
PAYFAST_MERCHANT_ID=...  PAYFAST_MERCHANT_KEY=...  PAYFAST_PASSPHRASE=...   PAYFAST_SANDBOX=1
OZOW_SITE_CODE=...  OZOW_PRIVATE_KEY=...  OZOW_API_KEY=... (optional)  OZOW_IS_TEST=1
PAYOUT_ENC_KEY=<base64 of 32 random bytes>    # openssl rand -base64 32  — back it up: losing it makes stored bank details unreadable
LIVE_MAX_VIEWERS=2000 (optional)
GOOGLE_MAPS_SERVER_KEY=...    # server-only; see "Google Maps" below
```

## Google Maps

One server-side key, `GOOGLE_MAPS_SERVER_KEY`, used only by the `maps` function. It is never sent to the browser, logged, stored in a table or echoed in an error.

1. Google Cloud console → create/choose a project with billing enabled → **APIs & Services → Library**, enable: **Places API (New)** (venue search + details), **Routes API** (travel time/distance), **Maps Static API** (map previews).
2. **Credentials → Create API key**. Restrict it: *API restrictions* = those three APIs only. *Application restrictions*: Supabase Edge Functions have no fixed IP, so leave it unrestricted by application but keep the API restriction, set **quotas** per API (e.g. a daily cap) and a **budget alert**.
3. Supabase → Edge Functions → Secrets → add `GOOGLE_MAPS_SERVER_KEY`. Deploy `maps` (`supabase functions deploy maps`). No app rebuild is needed: Admin → Discover → "Re-check" shows when it is live.
4. Without the key everything keeps working: event pages show the address and a plain "Open in Google Maps" link, map view says it is unavailable, venue search is hidden, and no distances or routes are ever invented.

Directions buttons use a normal `https://www.google.com/maps/dir/?api=1&destination=…` link, which needs no key and opens the Google Maps app on Android.

## Provider dashboards

* LiveKit → Settings → Webhooks → `https://<ref>.supabase.co/functions/v1/livekit-webhook`
* PayFast / Ozow notify URLs are sent with every payment; Ozow's site settings should also list `…/functions/v1/ozow-notify`.

## Deploy

`supabase functions deploy --project-ref <ref>` (uses `supabase/config.toml`, which turns JWT checks off for the three webhooks only).

## Check your credentials

`node --experimental-strip-types scripts/sandbox-check.mjs payfast|livekit|ozow`
