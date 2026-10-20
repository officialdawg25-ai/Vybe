// Supabase Edge Function (Deno). All logic lives in ../_shared so it can be unit-tested in Node.
import { handleLiveToken } from '../_shared/handlers/live.ts'

Deno.serve(req => handleLiveToken(req, { env: Deno.env.toObject(), fetch }))
