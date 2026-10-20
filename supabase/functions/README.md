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
```

## Provider dashboards

* LiveKit → Settings → Webhooks → `https://<ref>.supabase.co/functions/v1/livekit-webhook`
* PayFast / Ozow notify URLs are sent with every payment; Ozow's site settings should also list `…/functions/v1/ozow-notify`.

## Deploy

`supabase functions deploy --project-ref <ref>` (uses `supabase/config.toml`, which turns JWT checks off for the three webhooks only).

## Check your credentials

`node --experimental-strip-types scripts/sandbox-check.mjs payfast|livekit|ozow`
