// Supabase Edge Function (Deno). All logic lives in ../_shared so it can be unit-tested in Node.
import { handleLiveControl } from '../_shared/handlers/live.ts'

Deno.serve(req => handleLiveControl(req, { env: Deno.env.toObject(), fetch }))
