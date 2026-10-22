// Supabase Edge Function (Deno). All logic lives in ../_shared so it can be unit-tested in Node.
import { handleMediaProcess } from '../_shared/handlers/media.ts'

Deno.serve(req => handleMediaProcess(req, { env: Deno.env.toObject(), fetch }))
