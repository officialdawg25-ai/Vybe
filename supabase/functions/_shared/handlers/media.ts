// media-process: the server-side check for an uploaded photo or video in the media library.
// The browser uploads the file (and a thumbnail it made) and records a media_assets row with status "uploaded"; this
// function then reads the file's first bytes with the service role and decides:
//   * the content really is the image/video type it claims (magic bytes), not something renamed;
//   * its real size (from storage, not the browser's claim) is within VYBE's limits;
//   * for images, the real pixel dimensions; for MP4/MOV, the duration and frame size when the header is near the start;
//   * the thumbnail exists.
// It then sets status "ready" (with the measured values) or "failed" (with a reason people can read). Members cannot set
// the status themselves (migration 20). Transcoding to other formats is not done here: that needs a media service.
import { json, preflight, service, whoami, asUser, type Deps } from '../http.ts'

export const LIMITS = { image: 25 * 1024 * 1024, video: 50 * 1024 * 1024 }
const HEAD_BYTES = 256 * 1024
const UUID = /^[0-9a-f-]{36}$/i

export type Sniffed = { kind: 'image' | 'video'; mime: string } | null
export function sniff(b: Uint8Array): Sniffed {
  const s = (o: number, t: string) => [...t].every((c, i) => b[o + i] === c.charCodeAt(0))
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { kind: 'image', mime: 'image/jpeg' }
  if (b[0] === 0x89 && s(1, 'PNG')) return { kind: 'image', mime: 'image/png' }
  if (s(0, 'GIF8')) return { kind: 'image', mime: 'image/gif' }
  if (s(0, 'RIFF') && s(8, 'WEBP')) return { kind: 'image', mime: 'image/webp' }
  if (s(4, 'ftyp')) return { kind: 'video', mime: s(8, 'qt  ') ? 'video/quicktime' : 'video/mp4' }
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return { kind: 'video', mime: 'video/webm' }
  return null
}

const u16be = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1]
const u32be = (b: Uint8Array, o: number) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3]
const u16le = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8)
const u24le = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)

/** Pixel size from the image header (PNG, GIF, JPEG SOF, WebP VP8/VP8L/VP8X). Null when the header is not in the bytes read. */
export function imageSize(b: Uint8Array, mime: string): { width: number; height: number } | null {
  if (mime === 'image/png' && b.length >= 24) return { width: u32be(b, 16), height: u32be(b, 20) }
  if (mime === 'image/gif' && b.length >= 10) return { width: u16le(b, 6), height: u16le(b, 8) }
  if (mime === 'image/webp' && b.length >= 30) {
    const tag = String.fromCharCode(b[12], b[13], b[14], b[15])
    if (tag === 'VP8X') return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 }
    if (tag === 'VP8L') { const v = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24); return { width: (v & 0x3fff) + 1, height: ((v >> 14) & 0x3fff) + 1 } }
    if (tag === 'VP8 ') return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff }
  }
  if (mime === 'image/jpeg') {
    let o = 2
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) { o++; continue }
      const m = b[o + 1]
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { width: u16be(b, o + 7), height: u16be(b, o + 5) }
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { o += 2; continue }
      o += 2 + u16be(b, o + 2)
    }
  }
  return null
}

/** MP4/MOV: duration from mvhd and frame size from the first video tkhd, when the moov box is within the bytes read. */
export function mp4Info(b: Uint8Array): { duration_ms?: number; width?: number; height?: number } {
  const out: { duration_ms?: number; width?: number; height?: number } = {}
  const walk = (start: number, end: number, depth: number) => {
    let o = start
    while (o + 8 <= end && depth < 6) {
      let size = u32be(b, o); const type = String.fromCharCode(b[o + 4], b[o + 5], b[o + 6], b[o + 7])
      let hdr = 8
      if (size === 1) { if (o + 16 > end) return; size = u32be(b, o + 12); hdr = 16 }   // 64-bit size: high word ignored (files < 4 GB)
      if (size === 0) size = end - o
      if (size < hdr) return
      const body = o + hdr, stop = Math.min(o + size, end)
      if (type === 'moov' || type === 'trak') walk(body, stop, depth + 1)
      else if (type === 'mvhd' && body + 32 <= end) {
        const v = b[body]
        const [scale, dur] = v === 1 ? [u32be(b, body + 20), u32be(b, body + 24) * 2 ** 32 + u32be(b, body + 28)] : [u32be(b, body + 12), u32be(b, body + 16)]
        if (scale > 0) out.duration_ms = Math.round(dur / scale * 1000)
      } else if (type === 'tkhd' && out.width == null && body + (b[body] === 1 ? 96 : 84) <= end) {
        const at = b[body] === 1 ? body + 88 : body + 76
        const w = u32be(b, at) >>> 16, h = u32be(b, at + 4) >>> 16
        if (w > 0 && h > 0) { out.width = w; out.height = h }
      }
      if (o + size <= o) return
      o += size
    }
  }
  walk(0, b.length, 0)
  return out
}

/** Reads at most `max` bytes, even when the server ignores the Range header and sends the whole file. */
async function firstBytes(r: Response, max: number): Promise<Uint8Array> {
  if (!r.body) return new Uint8Array(await r.arrayBuffer()).slice(0, max)
  const reader = r.body.getReader(), out = new Uint8Array(max)
  let n = 0
  while (n < max) {
    const { done, value } = await reader.read()
    if (done || !value) break
    const take = Math.min(value.length, max - n)
    out.set(value.subarray(0, take), n); n += take
  }
  await reader.cancel().catch(() => {})
  return out.slice(0, n)
}

interface Asset { id: string; path: string; kind: 'image' | 'video'; mime: string; bytes: number; thumb_path: string | null; status: string; width: number | null; height: number | null; duration_ms: number | null }

export async function handleMediaProcess(req: Request, deps: Deps): Promise<Response> {
  const pre = preflight(req); if (pre) return pre
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)
  const me = await whoami(deps, req)
  if (!me) return json({ error: 'Sign in' }, 401)
  const body = (await req.json().catch(() => ({}))) as { asset_id?: string }
  if (!body.asset_id || !UUID.test(body.asset_id)) return json({ error: 'asset_id required' }, 400)

  // Read the row AS THE CALLER: only someone who can see the asset (its owner, or its organisation) can have it checked.
  const r = await asUser(deps, me.token).rest(`/rest/v1/media_assets?id=eq.${body.asset_id}&select=id,path,kind,mime,bytes,thumb_path,status,width,height,duration_ms`)
  const rows = r.ok ? ((await r.json()) as Asset[]) : []
  const a = rows[0]
  if (!a) return json({ error: 'Not found' }, 404)
  if (a.status === 'ready') return json({ status: 'ready' })

  const svc = service(deps)
  const patch = (p: Record<string, unknown>) => svc.rest(`/rest/v1/media_assets?id=eq.${a.id}`, { method: 'PATCH', headers: { prefer: 'return=minimal' }, body: JSON.stringify(p) })
  const fail = async (error: string) => { await patch({ status: 'failed', error, processed_at: new Date().toISOString() }); return json({ status: 'failed', error }) }
  await patch({ status: 'processing', error: null })

  const obj = await deps.fetch(`${deps.env.SUPABASE_URL}/storage/v1/object/authenticated/media/${a.path.split('/').map(encodeURIComponent).join('/')}`, {
    headers: { apikey: deps.env.SUPABASE_SERVICE_ROLE_KEY!, authorization: `Bearer ${deps.env.SUPABASE_SERVICE_ROLE_KEY}`, range: `bytes=0-${HEAD_BYTES - 1}` },
  })
  if (obj.status === 404 || obj.status === 400) return fail('The file is missing. Upload it again.')
  if (!obj.ok) { await patch({ status: 'uploaded' }); return json({ error: 'Storage is unavailable. Try again shortly.' }, 503) }
  const head = await firstBytes(obj, HEAD_BYTES)
  const total = Number((obj.headers.get('content-range') ?? '').split('/')[1]) || Number(obj.headers.get('content-length')) || head.length

  const found = sniff(head)
  if (!found) return fail('This is not a photo or video VYBE can show.')
  if (found.kind !== a.kind) return fail(`The file is a ${found.kind}, not a ${a.kind}.`)
  if (total > LIMITS[found.kind]) return fail(`Too large: ${found.kind === 'image' ? 'photos' : 'videos'} can be up to ${LIMITS[found.kind] / 1024 / 1024} MB.`)

  const done: Record<string, unknown> = { status: 'ready', error: null, mime: found.mime, bytes: total || a.bytes, processed_at: new Date().toISOString() }
  if (found.kind === 'image') { const s = imageSize(head, found.mime); if (s && s.width > 0 && s.height > 0 && s.width <= 20000 && s.height <= 20000) Object.assign(done, s) }
  else if (found.mime !== 'video/webm') {
    const m = mp4Info(head)
    if (m.duration_ms != null && m.duration_ms <= 86400000) done.duration_ms = m.duration_ms
    if (m.width && m.height && m.width <= 20000 && m.height <= 20000) Object.assign(done, { width: m.width, height: m.height })
  }
  if (a.thumb_path) {
    const t = await deps.fetch(`${deps.env.SUPABASE_URL}/storage/v1/object/authenticated/media/${a.thumb_path.split('/').map(encodeURIComponent).join('/')}`, {
      method: 'HEAD', headers: { apikey: deps.env.SUPABASE_SERVICE_ROLE_KEY!, authorization: `Bearer ${deps.env.SUPABASE_SERVICE_ROLE_KEY}` },
    })
    if (!t.ok) done.thumb_path = null
  }
  const w = await patch(done)
  if (!w.ok) return json({ error: 'Could not save the result. Try again.' }, 500)
  return json({ status: 'ready', mime: done.mime, bytes: done.bytes, width: done.width ?? a.width, height: done.height ?? a.height, duration_ms: done.duration_ms ?? a.duration_ms })
}
