# VYBE payments worker

`worker/index.ts` runs in the same Cloudflare Worker as the site (`wrangler.jsonc` → `main`). Static assets are served first-class;
only `/api/*` runs worker code.

## Secrets (never commit; set with `npx wrangler secret put NAME`)

| Name | Purpose |
| --- | --- |
| `SUPABASE_SERVICE_ROLE_KEY` | Lets the worker call `fulfill_order`, `close_order`, `expire_orders` (revoked from every browser role) |
| `PAYFAST_MERCHANT_ID`, `PAYFAST_MERCHANT_KEY`, `PAYFAST_PASSPHRASE` | PayFast checkout + ITN verification |
| `OZOW_SITE_CODE`, `OZOW_PRIVATE_KEY`, `OZOW_API_KEY` (optional) | Ozow checkout + notify verification |

Plain variables in `wrangler.jsonc`: `APP_ORIGIN`, `SUPABASE_URL`, and `PAYFAST_SANDBOX` / `OZOW_IS_TEST` (`"1"` while testing).

## Provider dashboards

* PayFast notify URL: `https://<origin>/api/pay/payfast/itn` (set automatically per payment).
* Ozow notify URL: `https://<origin>/api/pay/ozow/notify` (sent per payment; also set in the Ozow site settings).

## Abuse controls

Database: per-user velocity limits, unpaid-order holds that expire (15 min), per-order and per-person ticket caps, row-locked inventory,
idempotent order creation and idempotent fulfilment, amount verification, single-use door check-in, one transfer per ticket (friends only).
Edge (recommended, configured in the Cloudflare dashboard, not in code): a WAF rate-limiting rule on `/api/pay/start` (e.g. 10/min/IP) and
Turnstile on the checkout page if bot traffic appears.

## Not covered

Refunds and chargebacks, organizer payouts, VAT invoicing and reconciliation reports are **not implemented**. Fees are stored per order
(`subtotal_cents`, `fee_cents`) so revenue can be reported with plain SQL. Neither gateway has been exercised against its sandbox from this repo.
