// Supabase Edge Function (Deno). All logic lives in ../_shared so it can be unit-tested in Node.
import { handlePayoutAccount } from '../_shared/handlers/payouts.ts'

Deno.serve(req => handlePayoutAccount(req, { env: Deno.env.toObject(), fetch }))
