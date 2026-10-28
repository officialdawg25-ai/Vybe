import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { applySync, conflicts, judgeOffline, nextSeq, pending, serverNow, type Manifest, type ManifestTicket } from '../../src/lib/offline'

const h = (s: string) => createHash('sha256').update(s).digest('hex')
const NOW = Date.parse('2026-11-14T17:30:00Z')
const win = Math.floor(NOW / 1000 / 30)
const ticket = (o: Partial<ManifestTicket> = {}): ManifestTicket => ({
  t: '11111111-1111-4111-8111-111111111111', v: 2, k: h('secret:k3:t:2'), c: h('ABCDEFGHIJKLMNOPQRST'), r: 'VT-7KQM-2XPA', n: 'General', z: [],
  s: 'General Admission — No reserved seat', u: false, p: 'single', o: NOW / 1000 - 3600, x: NOW / 1000 + 3600, ss: false, g: true, ...o })
const manifest = (tickets: ManifestTicket[]): Manifest => ({ id: 'm1', event: { id: 'e1', title: 'UJ Concert', timezone: 'Africa/Johannesburg' }, gate: 'Gate 1',
  mode: 'offline_provisional', issued_at: '2026-11-14T15:00:00Z', valid_until: '2026-11-14T23:00:00Z', server_epoch: NOW / 1000, step_seconds: 30, tickets })
const token = (t: ManifestTicket, w = win, v = t.v) => `VYBE3:${t.t}:${v}:${w}:${h(`${t.k}:${w}`).slice(0, 20)}`

describe('offline judging (a phone with a manifest and no connection)', () => {
  it('a genuine live QR is accepted once on this phone, then ALREADY_USED here', async () => {
    const t = ticket(), m = manifest([t])
    expect((await judgeOffline(token(t), m, new Set(), NOW)).decision).toBe('ACCEPTED')
    expect((await judgeOffline(token(t), m, new Set([t.t]), NOW)).decision).toBe('ALREADY_USED')
  })
  it('upper-case QR (compact mode) is the same credential', async () => {
    const t = ticket(), m = manifest([t])
    expect((await judgeOffline(token(t).toUpperCase(), m, new Set(), NOW)).decision).toBe('ACCEPTED')
  })
  it('forged, altered, replaced or unknown credentials are INVALID', async () => {
    const t = ticket(), m = manifest([t])
    const good = token(t).split(':')
    expect((await judgeOffline([...good.slice(0, 4), good[4].replace(/.$/, c => (c === '0' ? '1' : '0'))].join(':'), m, new Set(), NOW)).decision).toBe('INVALID')
    expect((await judgeOffline(token(t, win, 1), m, new Set(), NOW)).decision).toBe('INVALID')           // an older version (transferred / reissued)
    expect((await judgeOffline(token({ ...t, t: '22222222-2222-4222-8222-222222222222' }), m, new Set(), NOW)).decision).toBe('INVALID')   // not in this event's manifest
    expect((await judgeOffline('{"event":"e1","tier":"vvip"}', m, new Set(), NOW)).decision).toBe('INVALID')
  })
  it('an old screenshot is QR_EXPIRED; window, gate, used, seat and session rules apply', async () => {
    const t = ticket()
    expect((await judgeOffline(token(t, win - 5), manifest([t]), new Set(), NOW)).decision).toBe('QR_EXPIRED')
    expect((await judgeOffline(token(t), manifest([ticket({ o: NOW / 1000 + 60 })]), new Set(), NOW)).decision).toBe('NOT_YET_VALID')
    expect((await judgeOffline(token(t), manifest([ticket({ x: NOW / 1000 - 60 })]), new Set(), NOW)).decision).toBe('EXPIRED')
    expect((await judgeOffline(token(t), manifest([ticket({ g: false })]), new Set(), NOW)).decision).toBe('WRONG_GATE_OR_ZONE')
    expect((await judgeOffline(token(t), manifest([ticket({ u: true })]), new Set(), NOW)).decision).toBe('ALREADY_USED')
    expect((await judgeOffline(token(t), manifest([ticket({ s: null })]), new Set(), NOW)).decision).toBe('MANUAL_REVIEW')
    expect((await judgeOffline(token(t), manifest([ticket({ ss: true })]), new Set(), NOW)).decision).toBe('MANUAL_REVIEW')
  })
  it('a typed static code works by hash (the manifest never holds the code itself)', async () => {
    const m = manifest([ticket()])
    expect((await judgeOffline('ABCDE FGHIJ KLMNO PQRST', m, new Set(), NOW)).decision).toBe('ACCEPTED')
    expect((await judgeOffline('VYBE1:ABCDEFGHIJKLMNOPQRST', m, new Set(), NOW)).decision).toBe('ACCEPTED')
    expect(JSON.stringify(m)).not.toContain('ABCDEFGHIJKLMNOPQRST')
  })
  it('an expired manifest admits nobody', async () => {
    const t = ticket()
    expect((await judgeOffline(token(t), { ...manifest([t]), valid_until: '2026-11-14T17:00:00Z' }, new Set(), NOW)).decision).toBe('MANIFEST_EXPIRED')
  })
  it('time comes from the server reading, not the phone clock', () => {
    expect(serverNow({ server_epoch: 1000 }, 50_000, 60_000)).toBe(1_010_000)
  })
})

describe('offline queue', () => {
  it('sequence numbers increase; sync outcomes are merged; conflicts stay visible', () => {
    const q = [{ id: 'a', seq: 1, at: '', decision: 'ACCEPTED' as const, ticket: 't', manifest: 'm', manifest_issued_at: '' }, { id: 'b', seq: 2, at: '', decision: 'ACCEPTED' as const, ticket: 'u', manifest: 'm', manifest_issued_at: '' }]
    expect(nextSeq(q)).toBe(3); expect(nextSeq([])).toBe(1)
    const after = applySync(q, [{ id: 'a', sync: 'confirmed' }, { id: 'b', sync: 'conflict', case: 7 }])
    expect(pending(after)).toHaveLength(0); expect(conflicts(after).map(x => x.case)).toEqual([7])
  })
})
