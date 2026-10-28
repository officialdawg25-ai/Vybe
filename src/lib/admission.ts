import { supabase } from './supabase'
import { isMissingSchema } from './tickets'
import type { LocalResult, Manifest, QueuedScan } from './offline'

/**
 * Event admission (migration 43): scanner sessions, the server's admission decision, door setup (zones, gates, sessions,
 * seats, ticket rules), the organiser's live numbers and the holder's ticket details. The server decides every outcome; this
 * side only shows it. A scan the server did not answer is never shown as admitted.
 */
export type Decision =
  | 'ACCEPTED' | 'EXITED' | 'WRONG_EVENT' | 'NOT_YET_VALID' | 'EXPIRED' | 'ALREADY_USED' | 'INVALID' | 'REVOKED' | 'WRONG_GATE_OR_ZONE'
  | 'WRONG_SESSION' | 'PAYMENT_NOT_CONFIRMED' | 'EVENT_CANCELLED' | 'EVENT_POSTPONED' | 'MANUAL_REVIEW' | 'QR_EXPIRED' | 'STATIC_CODE'
  | 'FORBIDDEN' | 'RATE_LIMITED'
export type Tone = 'admit' | 'deny' | 'hold'

export interface ScanResponse {
  decision: Decision; admit: boolean; message: string; event?: string; gate?: string | null; session?: string | null; replay?: boolean; override?: boolean
  reason?: string; valid_for?: string; valid_for_starts_at?: string | null; scanned_at?: string; opens_at?: string; closed_at?: string; used_at?: string | null; used_gate?: string | null
  status?: string; holder?: string | null
  /** Decided on this phone from offline data (migration 44): not checked against other phones until it is uploaded. */
  provisional?: boolean
  ticket?: { id: string; ref: string; type: string; tier: string; zones: string[]; seat: string; entry_policy: string; entries: number }
}
/** What the door screen shows: the server's answer, or a scan that never got one (offline / error) — never admitted. */
export type ScanOutcome = ScanResponse | { decision: 'NOT_VERIFIED'; admit: false; message: string; error: string }

export const DECISION_UI: Record<Decision | 'NOT_VERIFIED', { title: string; tone: Tone; hint?: string }> = {
  ACCEPTED: { title: 'ADMIT', tone: 'admit' },
  EXITED: { title: 'EXIT RECORDED', tone: 'admit', hint: 'They can come back in with the same ticket.' },
  WRONG_EVENT: { title: 'WRONG EVENT', tone: 'deny' },
  NOT_YET_VALID: { title: 'NOT YET VALID', tone: 'deny', hint: 'Entry has not opened for this ticket.' },
  EXPIRED: { title: 'EVENT ENDED / ENTRY CLOSED', tone: 'deny', hint: 'This ticket’s entry window has closed.' },
  ALREADY_USED: { title: 'ALREADY USED', tone: 'deny' },
  INVALID: { title: 'INVALID TICKET', tone: 'deny', hint: 'Not a ticket VYBE issued, or one that was replaced.' },
  REVOKED: { title: 'CANCELLED / REFUNDED', tone: 'deny', hint: 'This ticket no longer admits.' },
  WRONG_GATE_OR_ZONE: { title: 'WRONG GATE', tone: 'deny', hint: 'This ticket does not use this entrance. Send them to the right gate.' },
  WRONG_SESSION: { title: 'NOT FOR THIS SESSION', tone: 'deny' },
  PAYMENT_NOT_CONFIRMED: { title: 'PAYMENT NOT CONFIRMED', tone: 'deny', hint: 'The order is not paid. Do not admit.' },
  EVENT_CANCELLED: { title: 'EVENT CANCELLED', tone: 'deny' },
  EVENT_POSTPONED: { title: 'EVENT POSTPONED', tone: 'deny', hint: 'The organiser has postponed this event. Tickets stay valid for the new date.' },
  MANUAL_REVIEW: { title: 'HOLD — SUPERVISOR', tone: 'hold', hint: 'Do not admit yet. A supervisor must check this one.' },
  QR_EXPIRED: { title: 'QR EXPIRED', tone: 'hold', hint: 'Ask them to reopen the ticket in VYBE (the code changes every 30 seconds).' },
  STATIC_CODE: { title: 'OLD CODE', tone: 'hold', hint: 'Ask for the live QR in the VYBE app. Screenshots don’t work.' },
  FORBIDDEN: { title: 'NOT AUTHORISED', tone: 'deny', hint: 'You are not on the door team for this event or gate, or your session ended.' },
  RATE_LIMITED: { title: 'TOO MANY FAILED SCANS', tone: 'hold', hint: 'Wait a few minutes, then carry on.' },
  NOT_VERIFIED: { title: 'SYSTEM UNAVAILABLE — DO NOT ADMIT', tone: 'deny', hint: 'The server did not answer, so this ticket was not verified. Check the connection and retry it.' },
}

/** One line under the big answer: only what the door needs. */
export function decisionDetail(r: ScanOutcome, timeZone?: string): string[] {
  if (r.decision === 'NOT_VERIFIED') return [r.error]
  const at = (iso?: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit', day: 'numeric', month: 'short', ...(timeZone ? { timeZone } : {}) }) : '')
  const out: string[] = []
  if (r.decision === 'WRONG_EVENT') out.push(`This ticket is valid for ${r.valid_for ?? 'another event'}, not ${r.scanned_at ?? 'this event'}.`)
  if (r.decision === 'NOT_YET_VALID' && r.opens_at) out.push(`Entry opens ${at(r.opens_at)}.`)
  if (r.decision === 'EXPIRED' && r.closed_at) out.push(`Entry closed ${at(r.closed_at)}.`)
  if (r.decision === 'ALREADY_USED') out.push(r.reason === 'entry limit reached' ? 'Entry limit reached for this ticket.' : r.reason === 'already inside' ? 'Recorded as inside already (no exit scanned).' : `First used ${at(r.used_at)}${r.used_gate ? ` at ${r.used_gate}` : ''}.`)
  if (r.reason && !['entry limit reached', 'already inside'].includes(r.reason)) out.push(r.reason.charAt(0).toUpperCase() + r.reason.slice(1) + '.')
  if (r.ticket) {
    out.push([r.ticket.type, r.ticket.zones.length ? r.ticket.zones.join(', ') : null].filter(Boolean).join(' · '))
    out.push(r.ticket.seat)
  }
  if (r.provisional) out.unshift('PROVISIONAL — decided on this phone offline. Another phone may have admitted a copy; it is checked when this phone reconnects.')
  if (r.decision === 'ACCEPTED' && r.holder) out.push(`Holder: ${r.holder}`)
  if (r.override) out.push('Admitted by supervisor override (recorded).')
  if (r.replay) out.push('Same scan answered again (not counted twice).')
  return out.filter(Boolean)
}

const rpc = async <T>(fn: string, args: Record<string, unknown>) => {
  const { data, error } = await supabase.rpc(fn, args)
  if (error) throw new Error(error.message)
  return data as T
}

/* ---------------------------------------------------------------- the door */
export interface ScanSession {
  id: string; role: 'manager' | 'supervisor' | 'scanner'; server_time: string
  event: { id: string; title: string; starts_at: string; timezone: string; venue: string | null; status: string }
  gate: { id: string; name: string } | null; session: { id: string; name: string } | null
}
export const doorRole = async (eventId: string) => {
  const { data, error } = await supabase.rpc('door_role', { eid: eventId })
  if (error) { if (isMissingSchema(error)) return null; throw new Error(error.message) }
  const row = (Array.isArray(data) ? data[0] : data) as { role: string | null; gate: string | null } | null
  return row ?? { role: null, gate: null }
}
export const startScanSession = (eventId: string, gateId: string | null, sessionId: string | null, device: string) =>
  rpc<ScanSession>('start_scan_session', { p_event: eventId, p_gate: gateId, p_session: sessionId, p_device: device.slice(0, 60) })
export const endScanSession = (id: string) => rpc<void>('end_scan_session', { p_scan_session: id })
export const revokeScanSession = (id: string) => rpc<void>('revoke_scan_session', { p_scan_session: id })

/** A short label for this device (shown to the organiser next to the session). */
export function deviceLabel(ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''): string {
  const os = /Android/i.test(ua) ? 'Android' : /iPhone|iPad/i.test(ua) ? 'iPhone/iPad' : /Windows/i.test(ua) ? 'Windows' : /Mac OS/i.test(ua) ? 'Mac' : /Linux/i.test(ua) ? 'Linux' : 'Device'
  const br = /SamsungBrowser/i.test(ua) ? 'Samsung Internet' : /Edg\//i.test(ua) ? 'Edge' : /Chrome\//i.test(ua) ? 'Chrome' : /Firefox\//i.test(ua) ? 'Firefox' : /Safari\//i.test(ua) ? 'Safari' : 'Browser'
  return `${os} · ${br}`
}

/** What the camera or the keyboard gave us, tidied (spaces from a typed code, a stray newline from a scanner gun). */
export const normaliseCredential = (raw: string) => raw.trim().replace(/\s+/g, '')

/**
 * One scan, fail-closed. The same request id is reused on retries, so a scan the server already processed is never counted
 * twice; if every attempt fails the answer is NOT_VERIFIED (never admitted).
 */
export async function scanTicket(sessionId: string, credential: string, requestId: string, mode: 'entry' | 'exit', attempts = 3, call = rpc): Promise<ScanOutcome> {
  let last = ''
  for (let i = 0; i < attempts; i++) {
    try {
      return await call<ScanResponse>('admission_scan', { p_scan_session: sessionId, p_credential: credential, p_request: requestId, p_mode: mode })
    } catch (e) {
      last = e instanceof Error ? e.message : String(e)
      if (!/fetch|network|timeout|Failed to|Load failed|503|502|504/i.test(last)) break                // a real refusal: do not hammer
      await new Promise(r => setTimeout(r, 400 * 2 ** i))
    }
  }
  return { decision: 'NOT_VERIFIED', admit: false, message: DECISION_UI.NOT_VERIFIED.title, error: last || 'No answer from the server.' }
}
export const overrideAdmission = (sessionId: string, ticketId: string, requestId: string, reason: string) =>
  rpc<ScanResponse>('admission_override', { p_scan_session: sessionId, p_ticket: ticketId, p_request: requestId, p_reason: reason })

/* ---------------------------------------------------------------- organiser setup */
export interface Zone { id: string; name: string; kind: string; capacity: number | null }
export interface Gate { id: string; name: string; admits_unzoned: boolean; status: 'open' | 'closed'; zones: string[] }
export interface EventSession { id: string; name: string; starts_at: string; ends_at: string; doors_open_at: string | null; entry_closes_at: string | null; capacity?: number | null }
export interface TypeRules { id: string; name: string; entry_policy: 'single' | 'reentry'; max_entries: number | null; seating: 'none' | 'reserved'; seat_selection?: 'auto' | 'buyer'; entry_opens_at: string | null; entry_closes_at: string | null; zones: string[]; sessions: string[] }
export interface DoorStaff { user_id: string; role: 'scanner' | 'supervisor'; gate_id: string | null; expires_at: string | null; profiles: { username: string; display_name: string } | null }
export interface DoorSetup {
  event: { id: string; title: string; starts_at: string; ends_at: string | null; timezone: string; status: string; capacity: number | null; doors_open_at: string | null; entry_closes_at: string | null }
  zones: Zone[]; gates: Gate[]; sessions: EventSession[]; types: TypeRules[]; staff: DoorStaff[]; seats: { section: string; total: number }[]
}

export async function loadDoorSetup(eventId: string): Promise<DoorSetup | null> {
  const ev = await supabase.from('events').select('id,title,starts_at,ends_at,timezone,status,capacity,doors_open_at,entry_closes_at').eq('id', eventId).maybeSingle()
  if (ev.error) { if (isMissingSchema(ev.error)) return null; throw ev.error }
  if (!ev.data) return null
  const [zones, gates, gz, sessions, types, tz, ts, staff, seats] = await Promise.all([
    supabase.from('event_zones').select('id,name,kind,capacity').eq('event_id', eventId).order('name'),
    supabase.from('event_gates').select('id,name,admits_unzoned,status').eq('event_id', eventId).order('name'),
    supabase.from('gate_zones').select('gate_id,zone_id,event_gates!inner(event_id)').eq('event_gates.event_id', eventId),
    supabase.from('event_sessions').select('id,name,starts_at,ends_at,doors_open_at,entry_closes_at,capacity').eq('event_id', eventId).order('starts_at'),
    supabase.from('ticket_types').select('id,name,entry_policy,max_entries,seating,seat_selection,entry_opens_at,entry_closes_at').eq('event_id', eventId).order('sort'),
    supabase.from('ticket_type_zones').select('ticket_type_id,zone_id,ticket_types!inner(event_id)').eq('ticket_types.event_id', eventId),
    supabase.from('ticket_type_sessions').select('ticket_type_id,session_id,ticket_types!inner(event_id)').eq('ticket_types.event_id', eventId),
    supabase.from('event_staff').select('user_id,role,gate_id,expires_at,profiles:user_id(username,display_name)').eq('event_id', eventId),
    supabase.from('event_seats').select('section').eq('event_id', eventId).limit(10000),
  ])
  for (const r of [zones, gates, gz, sessions, types, tz, ts, staff, seats]) if (r.error) { if (isMissingSchema(r.error)) return null; throw r.error }
  const gzRows = (gz.data ?? []) as { gate_id: string; zone_id: string }[]
  const tzRows = (tz.data ?? []) as { ticket_type_id: string; zone_id: string }[]
  const tsRows = (ts.data ?? []) as { ticket_type_id: string; session_id: string }[]
  const bySection = new Map<string, number>()
  for (const s of (seats.data ?? []) as { section: string }[]) bySection.set(s.section, (bySection.get(s.section) ?? 0) + 1)
  return {
    event: ev.data as DoorSetup['event'],
    zones: (zones.data ?? []) as Zone[],
    gates: ((gates.data ?? []) as Omit<Gate, 'zones'>[]).map(g => ({ ...g, zones: gzRows.filter(x => x.gate_id === g.id).map(x => x.zone_id) })),
    sessions: (sessions.data ?? []) as EventSession[],
    types: ((types.data ?? []) as Omit<TypeRules, 'zones' | 'sessions'>[]).map(t => ({ ...t, zones: tzRows.filter(x => x.ticket_type_id === t.id).map(x => x.zone_id), sessions: tsRows.filter(x => x.ticket_type_id === t.id).map(x => x.session_id) })),
    staff: (staff.data ?? []) as unknown as DoorStaff[],
    seats: [...bySection].map(([section, total]) => ({ section, total })).sort((a, b) => a.section.localeCompare(b.section)),
  }
}

const must = <T>(r: { data: T; error: { message: string; code?: string } | null }) => { if (r.error) throw new Error(r.error.message); return r.data }
export const setEventEntry = async (eventId: string, patch: { doors_open_at?: string | null; entry_closes_at?: string | null; status?: string; starts_at?: string; ends_at?: string | null }) =>
  must(await supabase.from('events').update(patch).eq('id', eventId))
export const addZone = async (eventId: string, name: string, kind: string) => must(await supabase.from('event_zones').insert({ event_id: eventId, name: name.trim(), kind }))
export const removeZone = async (id: string) => must(await supabase.from('event_zones').delete().eq('id', id))
export const addGate = async (eventId: string, name: string, admitsUnzoned: boolean) => must(await supabase.from('event_gates').insert({ event_id: eventId, name: name.trim(), admits_unzoned: admitsUnzoned }))
export const updateGate = async (id: string, patch: Partial<Pick<Gate, 'admits_unzoned' | 'status' | 'name'>>) => must(await supabase.from('event_gates').update(patch).eq('id', id))
export const removeGate = async (id: string) => must(await supabase.from('event_gates').delete().eq('id', id))
export async function toggleLink(table: 'gate_zones' | 'ticket_type_zones' | 'ticket_type_sessions', a: string, b: string, on: boolean) {
  const [ka, kb] = table === 'gate_zones' ? ['gate_id', 'zone_id'] : table === 'ticket_type_zones' ? ['ticket_type_id', 'zone_id'] : ['ticket_type_id', 'session_id']
  must(on ? await supabase.from(table).insert({ [ka]: a, [kb]: b } as Record<string, string> as never) : await supabase.from(table).delete().eq(ka, a).eq(kb, b))
}
export const addSession = async (eventId: string, name: string, startsAt: string, endsAt: string) => must(await supabase.from('event_sessions').insert({ event_id: eventId, name: name.trim(), starts_at: startsAt, ends_at: endsAt }))
export const removeSession = async (id: string) => must(await supabase.from('event_sessions').delete().eq('id', id))
export const updateTypeRules = async (id: string, patch: Partial<Pick<TypeRules, 'entry_policy' | 'max_entries' | 'seating' | 'seat_selection' | 'entry_opens_at' | 'entry_closes_at'>>) =>
  must(await supabase.from('ticket_types').update(patch).eq('id', id))
export const generateSeats = (eventId: string, zoneId: string | null, section: string, rows: string[], perRow: number) =>
  rpc<number>('generate_seats', { p_event: eventId, p_zone: zoneId, p_section: section, p_rows: rows, p_seats_per_row: perRow })
export const updateStaff = async (eventId: string, userId: string, patch: Partial<Pick<DoorStaff, 'role' | 'gate_id' | 'expires_at'>>) =>
  must(await supabase.from('event_staff').update(patch).eq('event_id', eventId).eq('user_id', userId))

/** "A-F", "A,B,C" or "1-12" → row labels (at most 100). */
export function parseRows(s: string): string[] {
  const out: string[] = []
  for (const part of s.split(',').map(x => x.trim()).filter(Boolean)) {
    const m = part.match(/^([A-Za-z]|\d{1,3})\s*-\s*([A-Za-z]|\d{1,3})$/)
    if (m) {
      const [a, b] = [m[1], m[2]]
      if (/^\d+$/.test(a) && /^\d+$/.test(b)) for (let i = Number(a); i <= Number(b) && out.length < 100; i++) out.push(String(i))
      else if (/^[A-Za-z]$/.test(a) && /^[A-Za-z]$/.test(b)) for (let c = a.toUpperCase().charCodeAt(0); c <= b.toUpperCase().charCodeAt(0) && out.length < 100; c++) out.push(String.fromCharCode(c))
    } else if (part.length <= 10) out.push(part.toUpperCase())
  }
  return [...new Set(out)].slice(0, 100)
}

/* ---------------------------------------------------------------- live numbers */
export interface Dashboard {
  capacity: number | null; issued: number; admitted: number; inside_now: number; unseated: number
  by_decision: Record<string, number>; by_gate: { gate: string; admitted: number; denied: number }[]; by_type: { type: string; issued: number; admitted: number }[]
  active_scanners: { id: string; scanner: string; gate: string | null; device: string; last_seen_at: string }[]; repeat_denials: { ref: string; attempts: number }[]
}
export const admissionDashboard = (eventId: string) => rpc<Dashboard>('admission_dashboard', { p_event: eventId })

/* ---------------------------------------------------------------- the holder */
export interface TicketDetails {
  ref: string; status: string; event_status: string; entries: number; entry_policy: 'single' | 'reentry'; max_entries: number | null
  seat: string; zones: string[]; gates: string[]; sessions: { name: string; starts_at: string; ends_at: string; used: boolean }[]
  entry_opens_at: string; entry_closes_at: string; timezone: string
}
export async function myTicketDetails(ticketId: string): Promise<TicketDetails | null> {
  const { data, error } = await supabase.rpc('my_ticket_details', { p_ticket: ticketId })
  if (error) return null
  return (data ?? null) as TicketDetails | null
}
/** A used ticket can still admit when it allows re-entry or has sessions left. */
export const stillAdmits = (status: string, d: TicketDetails | null) =>
  status === 'valid' || (status === 'used' && !!d && (d.entry_policy === 'reentry' || d.sessions.some(s => !s.used)))
export const reissueTicket = (ticketId: string, reason: string) => rpc<void>('reissue_ticket', { p_ticket: ticketId, p_reason: reason })
export const revokeTicket = (ticketId: string, reason: string) => rpc<void>('revoke_ticket', { p_ticket: ticketId, p_reason: reason })
export async function myConflicts(eventId: string): Promise<{ id: string; title: string; starts_at: string }[]> {
  const { data, error } = await supabase.rpc('my_ticket_conflicts', { p_event: eventId })
  if (error || !Array.isArray(data)) return []
  return data as { id: string; title: string; starts_at: string }[]
}

/* ---------------------------------------------------------------- offline and venue-local admission (migration 44) */
export type AdmissionMode = 'online_only' | 'local_authority' | 'offline_provisional'
export async function eventAdmissionMode(eventId: string): Promise<{ mode: AdmissionMode; until: string | null; note: string } | null> {
  const { data, error } = await supabase.from('events').select('admission_mode,offline_authorized_until,offline_plan_note').eq('id', eventId).maybeSingle()
  if (error || !data) return null
  const d = data as { admission_mode: AdmissionMode; offline_authorized_until: string | null; offline_plan_note: string }
  return { mode: d.admission_mode, until: d.offline_authorized_until, note: d.offline_plan_note }
}
export const setAdmissionMode = (eventId: string, mode: AdmissionMode, until: string | null, note: string) =>
  rpc<void>('set_admission_mode', { p_event: eventId, p_mode: mode, p_until: until, p_note: note })
export const offlineManifest = (sessionId: string) => rpc<Manifest>('offline_manifest', { p_scan_session: sessionId })
export const offlineSync = (sessionId: string, items: QueuedScan[], mode: 'offline' | 'local' = 'offline') =>
  rpc<{ results: { id: string; sync: QueuedScan['synced']; case?: number | null; flags?: string[]; replay?: boolean }[] }>('offline_sync', {
    p_scan_session: sessionId, p_mode: mode,
    p_items: items.map(x => ({ id: x.id, seq: x.seq, at: x.at, decision: x.decision === 'MANIFEST_EXPIRED' ? 'INVALID' : x.decision, ticket: x.ticket, manifest: x.manifest, manifest_issued_at: x.manifest_issued_at })),
  })

/** A local (offline) decision in the same shape as the server's answer, always marked provisional. */
export function offlineOutcome(l: LocalResult): ScanOutcome {
  if (l.decision === 'MANIFEST_EXPIRED') return { decision: 'NOT_VERIFIED', admit: false, message: DECISION_UI.NOT_VERIFIED.title, error: 'Offline data has expired. Reconnect and reload it.' }
  const t = l.ticket
  return {
    decision: l.decision, admit: l.decision === 'ACCEPTED', message: l.decision, provisional: true, reason: l.reason,
    ticket: t ? { id: t.t, ref: t.r, type: t.n, tier: '', zones: t.z, seat: t.s ?? 'Reserved seat not assigned yet', entry_policy: t.p, entries: 0 } : undefined,
  }
}

export const setZoneCapacity = async (id: string, capacity: number | null) => must(await supabase.from('event_zones').update({ capacity }).eq('id', id))
export const setSessionCapacity = async (id: string, capacity: number | null) => must(await supabase.from('event_sessions').update({ capacity }).eq('id', id))
export interface Inventory {
  capacity: number | null
  types: { id: string; name: string; for_sale: number; seating: string; held: number; sold: number; valid: number; used: number; refunded: number; voided: number; available: number }[]
  zones: { id: string; name: string; capacity: number | null; taken: number }[]; sessions: { id: string; name: string; capacity: number | null; taken: number }[]
  seats: { total: number; blocked: number; sold: number; held: number }
}
export const inventoryReport = (eventId: string) => rpc<Inventory>('inventory_report', { p_event: eventId })

/* ---------------------------------------------------------------- scan investigation (migration 44) */
export interface ScanRow { id: number; at: string; device_time: string | null; decision: string; mode: string; sync: string | null; gate: string | null; scanner: string | null; device: string | null
  ticket: string | null; ref: string | null; ticket_status: string | null; type: string | null; order: string | null; case: number | null }
export interface ScanFilters { from?: string; to?: string; ref?: string; order?: string; decision?: string; gate?: string; type?: string; device?: string; mode?: string; sync?: string; conflicts?: boolean; case_status?: string }
export const scanSearch = (eventId: string, f: ScanFilters, limit: number, offset: number) =>
  rpc<{ total: number; rows: ScanRow[]; limit: number; offset: number }>('scan_search', { p_event: eventId, p_filters: Object.fromEntries(Object.entries(f).filter(([, v]) => v !== '' && v !== undefined && v !== false)), p_limit: limit, p_offset: offset })
export interface CaseView { id: number; kind: string; status: string; summary: string; resolution: string; created_at: string
  events: { at: string; action: string; detail: Record<string, unknown>; actor: string | null }[] | null
  actions: { id: number; kind: string; reason: string; status: string; requested_by: string; mine: boolean }[] | null }
export interface ScanDetail {
  scan: { id: number; at: string; device_time: string | null; decision: string; mode: string; sync: string | null; gate: string | null; scanner: string | null; device: string | null; reason: string | null; flags: string[] | null; device_seq: number | null }
  event: { id: string; title: string; starts_at: string; timezone: string }
  ticket: { id: string; ref: string; status: string; type: string; tier: string; entries: number; inside: boolean; seat: string | null; transfers: number; revoked_reason: string | null; order: string; order_status: string; refund: string | null } | null
  history: { id: number; at: string; device_time: string | null; decision: string; mode: string; sync: string | null; gate: string | null; scanner: string | null }[]
  admissions: { at: string; device_time: string | null; direction: string; mode: string; override: boolean; gate: string | null }[]
  cases: CaseView[]
}
export const scanDetail = (id: number) => rpc<ScanDetail>('scan_detail', { p_scan: id })
export const caseOpen = (scan: number, summary: string) => rpc<number>('case_open', { p_scan: scan, p_summary: summary })
export const caseUpdate = (id: number, action: 'note' | 'status', text: string, status?: string) => rpc<void>('case_update', { p_case: id, p_action: action, p_text: text, p_status: status ?? null })
export const caseRequestAction = (id: number, kind: 'revoke_ticket' | 'manual_admit', reason: string) => rpc<number>('case_request_action', { p_case: id, p_kind: kind, p_reason: reason })
export const caseDecideAction = (id: number, approve: boolean, note: string) => rpc<void>('case_decide_action', { p_action: id, p_approve: approve, p_note: note })
