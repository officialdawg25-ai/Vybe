import { asUser, json, need, preflight, service, whoami, type Deps } from '../http.ts'
import { decryptJson, encryptJson } from '../crypto.ts'

export interface BankDetails { account_number: string; branch_code: string; account_type: 'cheque' | 'savings' | 'transmission' }

/** Validates South African bank details loosely (digits only, sane lengths). Returns an error message or null. */
export function validateBank(b: { holder?: string; bank?: string; account_number?: string; branch_code?: string; account_type?: string }): string | null {
  if (!b.holder || b.holder.trim().length < 2 || b.holder.length > 120) return 'Enter the account holder name.'
  if (!b.bank || b.bank.trim().length < 2 || b.bank.length > 80) return 'Enter the bank name.'
  if (!/^\d{6,16}$/.test(b.account_number ?? '')) return 'Account numbers are 6 to 16 digits.'
  if (!/^\d{6}$/.test(b.branch_code ?? '')) return 'Branch codes are 6 digits.'
  if (!['cheque', 'savings', 'transmission'].includes(b.account_type ?? '')) return 'Choose an account type.'
  return null
}

/**
 * POST {action:'save', organization_id?, holder, bank, account_number, branch_code, account_type}
 *      {action:'reveal', account_id}   (admins only; every reveal is written to the audit log)
 * Bank details are encrypted with PAYOUT_ENC_KEY before they touch the database and are bound to the account id (AES-GCM AAD).
 */
export async function handlePayoutAccount(req: Request, deps: Deps): Promise<Response> {
  const pf = preflight(req); if (pf) return pf
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  const me = await whoami(deps, req)
  if (!me) return json({ error: 'Sign in again to continue.' }, 401)
  if (need(deps.env, 'PAYOUT_ENC_KEY').length) return json({ error: 'Payout accounts are not configured yet.' }, 503)
  const body = (await req.json().catch(() => ({}))) as Record<string, string | undefined>
  const user = asUser(deps, me.token), svc = service(deps)

  if (body.action === 'reveal') {
    const isAdmin = await (await user.rpc('is_admin', {})).json().catch(() => false)
    if (isAdmin !== true) return json({ error: 'Admins only.' }, 403)
    const id = body.account_id ?? ''
    if (!/^[0-9a-f-]{36}$/i.test(id)) return json({ error: 'Missing account.' }, 400)
    const row = ((await (await svc.rest(`/rest/v1/payout_accounts?id=eq.${id}&select=id,holder,bank,account_last4,details_enc,status`)).json().catch(() => [])) as { id: string; holder: string; bank: string; details_enc: string; status: string }[])[0]
    if (!row) return json({ error: 'Account not found.' }, 404)
    const details = await decryptJson<BankDetails>(deps.env.PAYOUT_ENC_KEY!, row.details_enc, row.id).catch(() => null)
    if (!details) return json({ error: 'These details can no longer be decrypted.' }, 500)
    await svc.rest('/rest/v1/audit_log', { method: 'POST', body: JSON.stringify({ actor: me.id, action: 'payout_account.revealed', entity_type: 'payout_account', entity_id: row.id }) })
    return json({ holder: row.holder, bank: row.bank, status: row.status, ...details })
  }

  const err = validateBank(body)
  if (err) return json({ error: err }, 400)
  const org = body.organization_id && /^[0-9a-f-]{36}$/i.test(body.organization_id) ? body.organization_id : null
  const allowed = await (await user.rpc('can_view_finance', { p_org: org, p_user: org ? null : me.id })).json().catch(() => false)
  if (allowed !== true) return json({ error: 'You do not have access to this organization’s finances.' }, 403)
  if (org) {
    const role = await (await user.rpc('org_role', { oid: org })).json().catch(() => null)
    if (role !== 'owner' && role !== 'admin') return json({ error: 'Only owners and admins can change payout details.' }, 403)
  }

  const filter = org ? `organization_id=eq.${org}` : `user_id=eq.${me.id}`
  const existing = ((await (await svc.rest(`/rest/v1/payout_accounts?${filter}&select=id`)).json().catch(() => [])) as { id: string }[])[0]
  const id = existing?.id ?? crypto.randomUUID()
  const details: BankDetails = { account_number: body.account_number!, branch_code: body.branch_code!, account_type: body.account_type as BankDetails['account_type'] }
  const row = { id, organization_id: org, user_id: org ? null : me.id, holder: body.holder!.trim(), bank: body.bank!.trim(), account_last4: body.account_number!.slice(-4),
    details_enc: await encryptJson(deps.env.PAYOUT_ENC_KEY!, details, id), status: 'pending', updated_at: new Date().toISOString() }
  const r = await svc.rest('/rest/v1/payout_accounts', { method: 'POST', headers: { prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(row) })
  if (!r.ok) return json({ error: 'Could not save the account.' }, 500)
  await svc.rest('/rest/v1/audit_log', { method: 'POST', body: JSON.stringify({ actor: me.id, action: existing ? 'payout_account.updated' : 'payout_account.created', entity_type: 'payout_account', entity_id: id }) })
  return json({ id, holder: row.holder, bank: row.bank, account_last4: row.account_last4, status: 'pending', note: 'Saved. An admin verifies new details before the first payout.' })
}
