// Supabase Edge Function (Deno). All logic lives in ../_shared so it can be unit-tested in Node.
import { handlePayStart } from '../_shared/handlers/pay.ts'

Deno.serve(req => handlePayStart(req, { env: Deno.env.toObject(), fetch }))
