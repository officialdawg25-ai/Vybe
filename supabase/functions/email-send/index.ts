// Supabase Edge Function (Deno). Logic lives in ../_shared/handlers/email.ts (unit-tested in Node); this file only adds
// the SMTP transport. Port 465 (implicit TLS): Supabase blocks outgoing connections to ports 25 and 587.
import { SMTPClient } from 'https://deno.land/x/denomailer@1.6.0/mod.ts'
import { handleEmailSend, oneLine, type Mail } from '../_shared/handlers/email.ts'

Deno.serve(async req => {
  const env = Deno.env.toObject()
  const conn: { client?: SMTPClient } = {}               // opened on the first message, reused for the batch
  const from = `${oneLine(env.SMTP_FROM_NAME || 'VYBE', 60)} <${env.SMTP_FROM_EMAIL}>`
  const send = async (m: Mail) => {
    conn.client ??= new SMTPClient({ connection: { hostname: env.SMTP_HOST!, port: Number(env.SMTP_PORT), tls: true, auth: { username: env.SMTP_USERNAME!, password: env.SMTP_PASSWORD! } } })
    await conn.client.send({ from, to: m.to, subject: m.subject, content: m.text })
  }
  try { return await handleEmailSend(req, { env, fetch, send }) }
  finally { try { await conn.client?.close() } catch { /* connection already gone */ } }
})
