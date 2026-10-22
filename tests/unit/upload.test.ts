import { describe, expect, it } from 'vitest'
import { CHUNK, UploadError, backoff, classify, queued, uploadObject, type Reply, type Req } from '../../src/lib/upload'

const reply = (status: number, headers: Record<string, string> = {}, text = ''): Reply => ({ status, header: n => headers[n.toLowerCase()] ?? null, text })
const file = (bytes: number) => new Blob([new Uint8Array(bytes)], { type: 'video/mp4' })
const noSleep = async () => {}
const base = { bucket: 'media', path: 'u/x.mp4', contentType: 'video/mp4', token: async () => 'tok', sleep: noSleep }

/** A fake TUS server: keeps the confirmed offset, can drop a request on demand. */
function tusServer(size: number, opts: { dropPatchAt?: number; expireAt?: number } = {}) {
  let offset = 0, sessions = 0, patches = 0
  const calls: string[] = []
  const request = async (r: Req): Promise<Reply> => {
    calls.push(`${r.method} ${r.headers['upload-offset'] ?? ''}`.trim())
    if (r.method === 'POST') { sessions++; offset = 0; return reply(201, { location: `https://x.supabase.co/storage/v1/upload/resumable/s${sessions}` }) }
    if (r.method === 'HEAD') return reply(200, { 'upload-offset': String(offset) })
    patches++
    if (opts.expireAt === patches) return reply(404)
    if (opts.dropPatchAt === patches) { offset += (r.body as Blob).size / 2; throw new UploadError('network', 'dropped') }   // half arrived, then the line dropped
    if (Number(r.headers['upload-offset']) !== offset) return reply(409)
    r.onProgress?.((r.body as Blob).size)
    offset += (r.body as Blob).size
    return reply(204, { 'upload-offset': String(offset) })
  }
  return { request, calls, get offset() { return offset }, get sessions() { return sessions }, size }
}

describe('upload transport', () => {
  it('small files go up in one request with progress to 100%', async () => {
    const seen: number[] = [], reqs: Req[] = []
    await uploadObject({ ...base, file: file(1000), onProgress: s => seen.push(s), request: async r => { reqs.push(r); r.onProgress?.(500); return reply(200) } })
    expect(reqs).toHaveLength(1)
    expect(reqs[0].url).toMatch(/\/storage\/v1\/object\/media\/u\/x\.mp4$/)
    expect(reqs[0].headers['x-upsert']).toBe('false')                  // never overwrites someone else's object
    expect(seen.at(-1)).toBe(1000)
  })
  it('retries a dropped connection, but not a refusal', async () => {
    let n = 0
    await uploadObject({ ...base, file: file(10), request: async () => { if (n++ < 2) throw new UploadError('network', 'x'); return reply(200) } })
    expect(n).toBe(3)
    n = 0
    await expect(uploadObject({ ...base, file: file(10), request: async () => { n++; return reply(403, {}, '{"message":"new row violates row-level security policy"}') } })).rejects.toMatchObject({ kind: 'rejected' })
    expect(n).toBe(1)
  })
  it('a retry that finds the object already stored counts as done (the first attempt had landed)', async () => {
    let n = 0
    await uploadObject({ ...base, file: file(10), request: async () => (n++ === 0 ? Promise.reject(new UploadError('network', 'x')) : reply(409, {}, '{"message":"The resource already exists"}')) })
    expect(n).toBe(2)
  })
  it('large files use resumable 6 MB chunks', async () => {
    const size = 2 * CHUNK + 1234, s = tusServer(size)
    await uploadObject({ ...base, file: file(size), request: s.request })
    expect(s.calls).toEqual(['POST', `PATCH 0`, `PATCH ${CHUNK}`, `PATCH ${2 * CHUNK}`])
    expect(s.offset).toBe(size)
  })
  it('after a dropped connection it asks the server where it got to and carries on from there (no restart)', async () => {
    const size = 3 * CHUNK, s = tusServer(size, { dropPatchAt: 2 })
    const progress: number[] = []
    await uploadObject({ ...base, file: file(size), request: s.request, onProgress: p => progress.push(p) })
    expect(s.sessions).toBe(1)
    expect(s.calls).toContain('HEAD')
    expect(s.calls).toContain(`PATCH ${CHUNK + CHUNK / 2}`)            // resumed mid-chunk, from the server's offset
    expect(s.offset).toBe(size)
    expect(progress.at(-1)).toBe(size)
  })
  it('an expired upload session starts a new one', async () => {
    const s = tusServer(2 * CHUNK, { expireAt: 2 })
    await uploadObject({ ...base, file: file(2 * CHUNK), request: s.request })
    expect(s.sessions).toBe(2)
    expect(s.offset).toBe(2 * CHUNK)
  })
  it('cancelling stops the upload', async () => {
    const ctrl = new AbortController()
    const p = uploadObject({ ...base, file: file(10), signal: ctrl.signal, request: async () => { ctrl.abort(); throw new UploadError('cancelled', 'Upload cancelled.') } })
    await expect(p).rejects.toMatchObject({ kind: 'cancelled' })
  })
  it('plain messages for permanent failures', () => {
    expect(classify(413, '').kind).toBe('too_large')
    expect(classify(400, '{"message":"mime type video/x-msvideo is not supported"}').kind).toBe('rejected')
    expect(classify(401, '').kind).toBe('auth')
    expect(classify(503, '').retryable).toBe(true)
    expect(classify(429, '').retryable).toBe(true)
  })
  it('backoff grows and is capped, with jitter', () => {
    expect(backoff(0, () => 0.5)).toBe(500)
    expect(backoff(3, () => 0.5)).toBe(4000)
    expect(backoff(20, () => 1)).toBeLessThanOrEqual(15_000 * 1.4)
  })
  it('runs at most three uploads at once; a cover can jump the line', async () => {
    let now = 0, peak = 0
    const order: string[] = []
    const gates: (() => void)[] = []
    const job = (name: string) => () => new Promise<void>(r => { now++; peak = Math.max(peak, now); order.push(name); gates.push(() => { now--; r() }) })
    const all = [queued(job('a')), queued(job('b')), queued(job('c')), queued(job('d')), queued(job('cover'), true)]
    await new Promise(r => setTimeout(r, 0))
    expect(order).toEqual(['a', 'b', 'c'])
    gates.shift()!(); await new Promise(r => setTimeout(r, 0))
    expect(order[3]).toBe('cover')
    while (gates.length) { gates.shift()!(); await new Promise(r => setTimeout(r, 0)) }
    await Promise.all(all)
    expect(peak).toBe(3)
  })
})
