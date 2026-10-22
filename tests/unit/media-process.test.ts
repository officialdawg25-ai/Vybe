import { describe, expect, it } from 'vitest'
import { handleMediaProcess, imageSize, mp4Info, sniff } from '../../supabase/functions/_shared/handlers/media.ts'
import type { Deps } from '../../supabase/functions/_shared/http.ts'

const UID = 'aaaaaaaa-0000-4000-8000-000000000001', AID = '11111111-2222-4333-8444-555555555555'
const PNG = (w: number, h: number) => { const b = new Uint8Array(64); b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); b.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8); new DataView(b.buffer).setUint32(16, w); new DataView(b.buffer).setUint32(20, h); return b }
const JPEG = (w: number, h: number) => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, ...new Array(14).fill(0), 0xff, 0xc0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3, ...new Array(9).fill(0)])
const box = (type: string, body: number[]) => { const n = 8 + body.length; return [n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255, ...[...type].map(c => c.charCodeAt(0)), ...body] }
const u32 = (n: number) => [n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255]
const MP4 = () => {
  const mvhd = box('mvhd', [0, 0, 0, 0, ...u32(0), ...u32(0), ...u32(1000), ...u32(12500), ...new Array(80).fill(0)])
  const tkhd = box('tkhd', [0, 0, 0, 0, ...new Array(72).fill(0), ...u32(1280 << 16), ...u32(720 << 16)])
  return new Uint8Array([...box('ftyp', [...'isom'].map(c => c.charCodeAt(0)).concat([0, 0, 2, 0])), ...box('moov', [...mvhd, ...box('trak', tkhd)])])
}

function world(asset: Record<string, unknown> | null, file: Uint8Array | null, opts: { total?: number; thumb?: boolean } = {}) {
  const patches: Record<string, unknown>[] = [], reads: string[] = []
  const f = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input), h = (init.headers ?? {}) as Record<string, string>
    if (url.endsWith('/auth/v1/user')) return h.authorization === 'Bearer good' ? new Response(JSON.stringify({ id: UID })) : new Response('{}', { status: 401 })
    if (url.includes('/rest/v1/media_assets') && (init.method ?? 'GET') === 'GET') { reads.push(h.authorization); return new Response(JSON.stringify(asset ? [asset] : [])) }
    if (url.includes('/rest/v1/media_assets') && init.method === 'PATCH') { patches.push(JSON.parse(String(init.body))); return new Response(null, { status: 204 }) }
    if (url.includes('/storage/v1/object/authenticated/media/')) {
      if (init.method === 'HEAD') return new Response(null, { status: opts.thumb === false ? 404 : 200 })
      if (!file) return new Response('{"error":"not_found"}', { status: 400 })
      return new Response(new Blob([file as BlobPart]), { status: 206, headers: { 'content-range': `bytes 0-${file.length - 1}/${opts.total ?? file.length}` } })
    }
    return new Response('{}', { status: 404 })
  }) as typeof fetch
  const deps: Deps = { env: { SUPABASE_URL: 'https://p.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'svc', SUPABASE_ANON_KEY: 'anon' }, fetch: f }
  const call = (id = AID, token = 'good') => handleMediaProcess(new Request('https://x/media-process', { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ asset_id: id }) }), deps)
  return { call, patches, reads }
}
const asset = (o: Record<string, unknown> = {}) => ({ id: AID, path: `${UID}/a.png`, kind: 'image', mime: 'image/png', bytes: 64, thumb_path: `${UID}/a-thumb.webp`, status: 'uploaded', width: null, height: null, duration_ms: null, ...o })

describe('media-process: header parsing', () => {
  it('recognises real content by its first bytes', () => {
    expect(sniff(PNG(1, 1))).toEqual({ kind: 'image', mime: 'image/png' })
    expect(sniff(JPEG(1, 1))?.mime).toBe('image/jpeg')
    expect(sniff(MP4())).toEqual({ kind: 'video', mime: 'video/mp4' })
    expect(sniff(new TextEncoder().encode('<html><script>alert(1)</script>'))).toBeNull()
  })
  it('reads image dimensions from PNG and JPEG headers', () => {
    expect(imageSize(PNG(1920, 1080), 'image/png')).toEqual({ width: 1920, height: 1080 })
    expect(imageSize(JPEG(4032, 3024), 'image/jpeg')).toEqual({ width: 4032, height: 3024 })
  })
  it('reads MP4 duration and frame size from moov', () => {
    expect(mp4Info(MP4())).toEqual({ duration_ms: 12500, width: 1280, height: 720 })
  })
})

describe('media-process: the worker', () => {
  it('refuses callers who are not signed in', async () => {
    const w = world(asset(), PNG(10, 10))
    expect((await w.call(AID, 'bad')).status).toBe(401)
    expect(w.patches).toHaveLength(0)
  })
  it('looks the asset up as the caller, so people cannot process assets they cannot see', async () => {
    const w = world(null, PNG(10, 10))
    expect((await w.call()).status).toBe(404)
    expect(w.reads[0]).toBe('Bearer good')
    expect(w.patches).toHaveLength(0)
  })
  it('marks a real image ready with its measured size and real byte count', async () => {
    const w = world(asset({ bytes: 1 }), PNG(800, 600), { total: 123456 })
    const r = await (await w.call()).json()
    expect(r.status).toBe('ready')
    expect(w.patches[0]).toMatchObject({ status: 'processing' })
    expect(w.patches.at(-1)).toMatchObject({ status: 'ready', width: 800, height: 600, bytes: 123456, mime: 'image/png' })
  })
  it('marks a video ready with duration and frame size', async () => {
    const w = world(asset({ kind: 'video', mime: 'video/mp4', path: `${UID}/v.mp4` }), MP4())
    await w.call()
    expect(w.patches.at(-1)).toMatchObject({ status: 'ready', duration_ms: 12500, width: 1280, height: 720 })
  })
  it('fails a renamed file, a kind mismatch, an oversize file and a missing file, with a readable reason', async () => {
    const html = world(asset(), new TextEncoder().encode('<html>not an image</html>'))
    expect((await (await html.call()).json()).error).toMatch(/not a photo or video/)
    const kind = world(asset({ kind: 'video', mime: 'video/mp4' }), PNG(1, 1))
    expect((await (await kind.call()).json()).error).toMatch(/is a image, not a video|image, not a video/)
    const big = world(asset(), PNG(1, 1), { total: 30 * 1024 * 1024 })
    expect((await (await big.call()).json()).error).toMatch(/Too large/)
    const gone = world(asset(), null)
    expect((await (await gone.call()).json()).error).toMatch(/missing/)
    for (const w of [html, kind, big, gone]) expect(w.patches.at(-1)).toMatchObject({ status: 'failed' })
  })
  it('drops a thumbnail that is not in storage instead of pointing at nothing', async () => {
    const w = world(asset(), PNG(5, 5), { thumb: false })
    await w.call()
    expect(w.patches.at(-1)).toMatchObject({ status: 'ready', thumb_path: null })
  })
})
