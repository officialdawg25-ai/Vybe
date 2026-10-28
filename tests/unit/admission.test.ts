import { describe, expect, it, vi } from 'vitest'
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc: vi.fn(), from: vi.fn() } }))
import { DECISION_UI, decisionDetail, deviceLabel, normaliseCredential, parseRows, scanTicket, stillAdmits, type ScanResponse } from '../../src/lib/admission'

describe('door scans are fail-closed', () => {
  it('retries a network failure with the SAME request id, so the server never counts the scan twice', async () => {
    const seen: string[] = []
    let n = 0
    const call = vi.fn(async (_fn: string, args: Record<string, unknown>) => {
      seen.push(args.p_request as string)
      if (++n < 3) throw new Error('Failed to fetch')
      return { decision: 'ACCEPTED', admit: true, message: 'ADMIT' } as ScanResponse
    })
    const r = await scanTicket('sess', 'VYBE3:x', 'req-1', 'entry', 3, call as never)
    expect(r.decision).toBe('ACCEPTED')
    expect(new Set(seen)).toEqual(new Set(['req-1'])); expect(seen).toHaveLength(3)
  }, 10_000)

  it('no answer from the server is NOT VERIFIED, never admitted', async () => {
    const call = vi.fn(async () => { throw new Error('Failed to fetch') })
    const r = await scanTicket('sess', 'VYBE3:x', 'req-2', 'entry', 2, call as never)
    expect(r).toMatchObject({ decision: 'NOT_VERIFIED', admit: false })
    expect(DECISION_UI.NOT_VERIFIED.tone).toBe('deny')
  }, 10_000)

  it('a real refusal (not a network error) is not retried', async () => {
    const call = vi.fn(async () => { throw new Error('permission denied for function admission_scan') })
    const r = await scanTicket('sess', 'x', 'req-3', 'entry', 3, call as never)
    expect(call).toHaveBeenCalledTimes(1); expect(r.admit).toBe(false)
  })

  it('only ACCEPTED and EXITED read as "admit"; holds and denials never do', () => {
    const admits = Object.entries(DECISION_UI).filter(([, v]) => v.tone === 'admit').map(([k]) => k).sort()
    expect(admits).toEqual(['ACCEPTED', 'EXITED'])
  })
})

describe('door messages', () => {
  it('WRONG EVENT names the event the ticket is for and the one being scanned', () => {
    const lines = decisionDetail({ decision: 'WRONG_EVENT', admit: false, message: '', valid_for: 'UJ Student Concert', scanned_at: 'TUT Campus Festival' })
    expect(lines[0]).toBe('This ticket is valid for UJ Student Concert, not TUT Campus Festival.')
  })
  it('a ticket without a seat says General Admission, never an invented seat', () => {
    const lines = decisionDetail({ decision: 'ACCEPTED', admit: true, message: '', ticket: { id: 'x', ref: 'VT-AAAA-BBBB', type: 'General', tier: 'general', zones: [], seat: 'General Admission — No reserved seat', entry_policy: 'single', entries: 1 } })
    expect(lines).toContain('General Admission — No reserved seat')
  })
  it('ALREADY USED shows when and where', () => {
    const [l] = decisionDetail({ decision: 'ALREADY_USED', admit: false, message: '', used_at: '2026-10-28T18:05:00Z', used_gate: 'Gate A' }, 'Africa/Johannesburg')
    expect(l).toMatch(/^First used .*(20:05|8:05\sPM).* at Gate A\.$/)          // shown in the event's own time zone (SAST)
  })
})

describe('offline answers', () => {
  it('ALREADY USED on this phone says so, without an empty "first used" time', () => {
    const lines = decisionDetail({ decision: 'ALREADY_USED', admit: false, message: '', provisional: true, reason: 'already accepted on this phone' })
    expect(lines.some(l => l.startsWith('First used'))).toBe(false)
    expect(lines).toContain('Already accepted on this phone.')
    expect(lines[0]).toMatch(/^PROVISIONAL/)
  })
})

describe('helpers', () => {
  it('row ranges', () => {
    expect(parseRows('A-D')).toEqual(['A', 'B', 'C', 'D'])
    expect(parseRows('1-3, 10')).toEqual(['1', '2', '3', '10'])
    expect(parseRows('a, b, a')).toEqual(['A', 'B'])
    expect(parseRows('1-500')).toHaveLength(100)
  })
  it('credentials are tidied, not reinterpreted', () => {
    expect(normaliseCredential('  ABCDE FGHIJ\n')).toBe('ABCDEFGHIJ')
    expect(normaliseCredential('VYBE3:abc:0:1:ff')).toBe('VYBE3:abc:0:1:ff')
  })
  it('device labels', () => {
    expect(deviceLabel('Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0 Mobile Safari/537.36')).toBe('Android · Samsung Internet')
  })
  it('a used ticket still shows its QR only for re-entry or unused sessions', () => {
    const base = { ref: '', status: 'used', event_status: 'active', entries: 1, max_entries: null, seat: '', zones: [], gates: [], entry_opens_at: '', entry_closes_at: '', timezone: 'UTC' }
    expect(stillAdmits('used', { ...base, entry_policy: 'single', sessions: [] })).toBe(false)
    expect(stillAdmits('used', { ...base, entry_policy: 'reentry', sessions: [] })).toBe(true)
    expect(stillAdmits('used', { ...base, entry_policy: 'single', sessions: [{ name: 'Day 2', starts_at: '', ends_at: '', used: false }] })).toBe(true)
    expect(stillAdmits('refunded', null)).toBe(false); expect(stillAdmits('valid', null)).toBe(true)
  })
})
