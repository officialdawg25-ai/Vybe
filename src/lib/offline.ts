/**
 * Offline admission (migration 44): judging a ticket against a supervisor-loaded manifest when the server cannot be reached,
 * plus the queue that uploads those scans later. Pure functions (no DOM, no network), shared by the door screen and the
 * venue-local gate service, and unit-tested.
 *
 * Limits, stated plainly: one phone can only know what it has seen. Two phones offline can each accept a copy of the same
 * ticket; that is found only when both upload (a conflict case). A ticket revoked after the manifest was loaded still passes
 * until the manifest is refreshed. Every offline acceptance is therefore PROVISIONAL.
 */
export interface ManifestTicket {
  t: string; v: number; k: string; c: string; r: string; n: string; z: string[]; s: string | null
  u: boolean; p: 'single' | 'reentry'; o: number; x: number; ss: boolean; g: boolean
}
export interface Manifest {
  id: string; event: { id: string; title: string; timezone: string }; gate: string | null; mode: 'local_authority' | 'offline_provisional'
  issued_at: string; valid_until: string; server_epoch: number; step_seconds: number; tickets: ManifestTicket[]
}
export type LocalDecision = 'ACCEPTED' | 'ALREADY_USED' | 'INVALID' | 'NOT_YET_VALID' | 'EXPIRED' | 'WRONG_GATE_OR_ZONE' | 'MANUAL_REVIEW' | 'QR_EXPIRED' | 'MANIFEST_EXPIRED'
export interface LocalResult { decision: LocalDecision; ticket?: ManifestTicket; reason?: string }
export interface QueuedScan { id: string; seq: number; at: string; decision: LocalDecision; ticket: string | null; manifest: string; manifest_issued_at: string; synced?: 'confirmed' | 'conflict' | 'rejected' | 'recorded'; case?: number | null }

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('')
export async function sha256hex(s: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))
}

/** Server time now, from the manifest's clock reading and how long ago (by this device's clock) it was taken. */
export const serverNow = (m: Pick<Manifest, 'server_epoch'>, loadedAtMs: number, nowMs = Date.now()) => m.server_epoch * 1000 + (nowMs - loadedAtMs)

/**
 * Judge one credential. `seen` is this device's own ledger (ticket id → already accepted here). Never consults anything the
 * credential claims beyond its ticket id and version; the manifest is the authority, and the signature binds both.
 */
export async function judgeOffline(raw: string, m: Manifest, seen: ReadonlySet<string>, nowServerMs: number): Promise<LocalResult> {
  if (nowServerMs > Date.parse(m.valid_until)) return { decision: 'MANIFEST_EXPIRED', reason: 'offline data expired: reconnect and reload it' }
  const cred = raw.trim()
  let tk: ManifestTicket | undefined, stale = false
  const parts = cred.split(':')
  if (parts[0]?.toUpperCase() === 'VYBE3' && parts.length === 5) {
    const id = parts[1].toLowerCase(), ver = Number(parts[2]), win = Number(parts[3]), sig = parts[4].toLowerCase()
    tk = m.tickets.find(x => x.t === id)
    if (!tk || tk.v !== ver || !Number.isFinite(win)) return { decision: 'INVALID' }
    if ((await sha256hex(`${tk.k}:${win}`)).slice(0, 20) !== sig) return { decision: 'INVALID' }
    stale = Math.abs(Math.floor(nowServerMs / 1000 / m.step_seconds) - win) > 1
  } else if (/^(VYBE1:?)?[A-Za-z0-9 ]{20,30}$/i.test(cred)) {
    const code = cred.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^VYBE1/, '')
    const h = await sha256hex(code)
    tk = m.tickets.find(x => x.c === h)
    if (!tk) return { decision: 'INVALID' }
  } else return { decision: 'INVALID' }
  const s = nowServerMs / 1000
  if (tk.ss || tk.p === 'reentry') return { decision: 'MANUAL_REVIEW', ticket: tk, reason: 'session or re-entry ticket: needs the online check' }
  if (!tk.g) return { decision: 'WRONG_GATE_OR_ZONE', ticket: tk }
  if (s < tk.o) return { decision: 'NOT_YET_VALID', ticket: tk }
  if (s > tk.x) return { decision: 'EXPIRED', ticket: tk }
  if (tk.u || seen.has(tk.t)) return { decision: 'ALREADY_USED', ticket: tk, reason: tk.u ? 'used before the offline data was loaded' : 'already accepted on this phone' }
  if (tk.s === null) return { decision: 'MANUAL_REVIEW', ticket: tk, reason: 'reserved seat not assigned' }
  if (stale) return { decision: 'QR_EXPIRED', ticket: tk }
  return { decision: 'ACCEPTED', ticket: tk }
}

/** Next sequence number for this device's queue (gaps are reported by the server, so it never reuses or skips on purpose). */
export const nextSeq = (q: Pick<QueuedScan, 'seq'>[]) => q.reduce((a, x) => Math.max(a, x.seq), 0) + 1

/** Merge the server's sync answer into the queue. Scans stay listed (with their outcome) until the next manifest load. */
export function applySync(q: QueuedScan[], results: { id: string; sync: QueuedScan['synced']; case?: number | null }[]): QueuedScan[] {
  const by = new Map(results.map(r => [r.id, r]))
  return q.map(x => (by.has(x.id) ? { ...x, synced: by.get(x.id)!.sync, case: by.get(x.id)!.case ?? null } : x))
}
export const pending = (q: QueuedScan[]) => q.filter(x => !x.synced)
export const conflicts = (q: QueuedScan[]) => q.filter(x => x.synced === 'conflict' || x.synced === 'rejected')
