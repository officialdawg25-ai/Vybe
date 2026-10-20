// Supabase Edge Function (Deno). All logic lives in ../_shared so it can be unit-tested in Node.
import { handlePayfastItn } from '../_shared/handlers/pay.ts'

Deno.serve(req => handlePayfastItn(req, { env: Deno.env.toObject(), fetch }))
