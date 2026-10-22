// Supabase Edge Function (Deno). All logic lives in ../_shared so it can be unit-tested in Node.
import { handleUsernameSignin } from '../_shared/handlers/signin.ts'

Deno.serve(req => handleUsernameSignin(req, { env: Deno.env.toObject(), fetch }))
