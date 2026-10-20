// Supabase Edge Function (Deno). All logic lives in ../_shared so it can be unit-tested in Node.
import { handleMaps } from '../_shared/handlers/maps.ts'

Deno.serve(req => handleMaps(req, { env: Deno.env.toObject(), fetch }))
