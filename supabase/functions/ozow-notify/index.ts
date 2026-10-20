// Supabase Edge Function (Deno). All logic lives in ../_shared so it can be unit-tested in Node.
import { handleOzowNotify } from '../_shared/handlers/pay.ts'

Deno.serve(req => handleOzowNotify(req, { env: Deno.env.toObject(), fetch }))
