// Supabase Edge Function (Deno). All logic lives in ../_shared so it can be unit-tested in Node.
import { handleChatRecovery } from '../_shared/handlers/recovery.ts'

Deno.serve(req => handleChatRecovery(req, { env: Deno.env.toObject(), fetch }))
