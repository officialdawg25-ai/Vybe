import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
// @ts-expect-error plain ESM module without types
import { createGate } from '../../local-gate/gate.mjs'

const h = (s: string) => createHash('sha256').update(s).digest('hex')
const NOW = Date.parse('2026-11-14T17:30:00Z')
const T1 = { t: '11111111-1111-4111-8111-111111111111', v: 0, k: h('k1'), c: h('ABCDEFGHIJKLMNOPQRST'), r: 'VT-AAAA-BBBB', n: 'General', z: [], s: 'General Admission — No reserved seat', u: false, p: 'single', o: NOW / 1000 - 3600, x: NOW / 1000 + 3600, ss: false, g: true }
const T2 = { ...T1, t: '22222222-2222-4222-8222-222222222222', k: h('k2'), c: h('ZZZZZZZZZZZZZZZZZZZZ'), r: 'VT-CCCC-DDDD' }
const tok = (t: typeof T1, w = Math.floor(clock / 1000 / 30)) => `VYBE3:${t.t}:${t.v}:${w}:${h(`${t.k}:${w}`).slice(0, 20)}`   // the holder's live QR right now
let clock = NOW
const dir = mkdtempSync(join(tmpdir(), 'gate-'))
const files = { manifestPath: join(dir, 'm.json'), ledgerPath: join(dir, 'l.jsonl'), statePath: join(dir, 's.json') }
writeFileSync(files.manifestPath, JSON.stringify({ id: 'mf-1', event: { id: 'e1', title: 'UJ Concert', timezone: 'Africa/Johannesburg' }, gate: 'Gate 1', mode: 'local_authority',
  issued_at: '2026-11-14T15:00:00Z', valid_until: '2026-11-14T23:00:00Z', server_epoch: NOW / 1000, step_seconds: 30, tickets: [T1, T2] }))
const start = async () => {
  const s = createGate({ ...files, pin: '123456', adminPin: '87654321', now: () => clock })
  await new Promise<void>(r => s.listen(0, '127.0.0.1', () => r()))
  return { s, url: `http://127.0.0.1:${(s.address() as AddressInfo).port}` }
}
let g: Awaited<ReturnType<typeof start>>
const pair = async (url: string, pin = '123456') => fetch(`${url}/pair`, { method: 'POST', body: JSON.stringify({ pin, label: 'phone' }) })
const scan = async (url: string, token: string, credential: string, request = crypto.randomUUID()) =>
  (await fetch(`${url}/scan`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ credential, request }) })).json()

beforeAll(async () => { g = await start() })
afterAll(() => { g.s.close() })

describe('local gate (venue Wi-Fi authority)', () => {
  it('needs a paired phone; wrong PINs are refused and locked out after 5 tries', async () => {
    expect((await fetch(`${g.url}/scan`, { method: 'POST', body: '{}' })).status).toBe(401)
    for (let i = 0; i < 5; i++) expect((await pair(g.url, '000000')).status).toBe(403)
    expect((await pair(g.url, '123456')).status).toBe(429)                      // locked even with the right PIN, for a while
    clock += 6 * 60_000
    expect((await pair(g.url)).status).toBe(200)
  })

  it('50 phones scanning the same ticket at the same moment: exactly one ADMIT', async () => {
    const tokens = await Promise.all(Array.from({ length: 5 }, async () => (await (await pair(g.url)).json()).token as string))
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => scan(g.url, tokens[i % 5], tok(T1))))
    expect(results.filter(r => r.decision === 'ACCEPTED')).toHaveLength(1)
    expect(results.filter(r => r.decision === 'ALREADY_USED')).toHaveLength(49)
  })

  it('a retried request gets the same answer and is not counted twice; forged codes are refused', async () => {
    const token = (await (await pair(g.url)).json()).token
    const req = crypto.randomUUID()
    const a = await scan(g.url, token, tok(T2), req), b = await scan(g.url, token, tok(T2), req)
    expect(a.decision).toBe('ACCEPTED'); expect(b).toMatchObject({ decision: 'ACCEPTED', replay: true, id: a.id })
    expect((await scan(g.url, token, tok(T2).replace(/.$/, c => (c === '0' ? '1' : '0')))).decision).toBe('INVALID')
    const lines = readFileSync(files.ledgerPath, 'utf8').trim().split('\n')
    expect(lines.filter(l => JSON.parse(l).decision === 'ACCEPTED')).toHaveLength(2)
  })

  it('after a power cut (restart) the ledger is replayed: nothing admitted twice', async () => {
    g.s.close(); g = await start()
    const token = (await (await pair(g.url)).json()).token
    expect((await scan(g.url, token, tok(T1))).decision).toBe('ALREADY_USED')
    expect((await (await fetch(`${g.url}/health`)).json())).toMatchObject({ admitted: 2, event: 'UJ Concert' })
  })

  it('the supervisor export is in the shape VYBE offline_sync takes; it needs the admin PIN', async () => {
    expect((await fetch(`${g.url}/export`)).status).toBe(403)
    const ex = await (await fetch(`${g.url}/export`, { headers: { 'x-admin-pin': '87654321' } })).json()
    expect(ex.items.filter((x: any) => x.decision === 'ACCEPTED').map((x: any) => x.ticket).sort()).toEqual([T1.t, T2.t])
    expect(Object.keys(ex.items[0]).sort()).toEqual(['at', 'decision', 'id', 'manifest', 'manifest_issued_at', 'seq', 'ticket'])
    expect(JSON.stringify(ex)).not.toMatch(/token|pin/i)
  })

  it('once the gate data expires, nobody is admitted', async () => {
    clock = Date.parse('2026-11-15T01:00:00Z')
    const token = (await (await pair(g.url)).json()).token
    expect((await scan(g.url, token, 'ZZZZZ ZZZZZ ZZZZZ ZZZZZ')).decision).toBe('MANIFEST_EXPIRED')
  })
})
