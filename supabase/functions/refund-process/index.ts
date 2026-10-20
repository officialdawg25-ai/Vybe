// Supabase Edge Function (Deno). All logic lives in ../_shared so it can be unit-tested in Node.
import { handleRefundProcess } from '../_shared/handlers/refunds.ts'

Deno.serve(req => handleRefundProcess(req, { env: Deno.env.toObject(), fetch }))
