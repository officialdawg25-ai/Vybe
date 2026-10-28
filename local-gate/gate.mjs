// VYBE local gate: a venue-local admission authority for when the venue has no internet but has its own Wi-Fi.
//
// One small computer (laptop, mini-PC) on the venue network runs this. Every door phone on that network scans through it, so
// it is the ONE place that decides: a ticket accepted at Gate 1 is refused at Gate 3 a second later, with no internet at all.
// It judges with the same rules as the VYBE app's offline mode (src/lib/offline.ts) against a manifest a supervisor exported
// from VYBE before the doors opened, writes every decision to an append-only ledger on disk (fsync before answering), and the
// ledger is uploaded to VYBE afterwards (Door scanner → "Upload venue ledger"), where it is reconciled with any online scans.
//
// What it does not do: it cannot see scans made outside it (online phones, other boxes), and it cannot learn about tickets
// refunded or revoked after the manifest was exported. Both show up as conflict cases when the ledger is uploaded.
import { createServer as httpServer } from 'node:http'
import { createServer as httpsServer } from 'node:https'
import { readFileSync, writeFileSync, existsSync, openSync, writeSync, fsyncSync, closeSync } from 'node:fs'
import { randomBytes, timingSafeEqual, randomUUID } from 'node:crypto'
import { judgeOffline } from '../src/lib/offline.ts'

const PAGE = readFileSync(new URL('./page.html', import.meta.url), 'utf8')

/**
 * @param {{ manifestPath: string, ledgerPath: string, statePath: string, pin: string, adminPin: string, maxDevices?: number, now?: () => number }} o
 */
export function createGate(o) {
  if (!/^\d{6,}$/.test(o.pin) || !/^\d{8,}$/.test(o.adminPin) || o.pin === o.adminPin) throw new Error('Set PAIRING_PIN (6+ digits) and a different ADMIN_PIN (8+ digits).')
  const now = o.now ?? Date.now
  const manifest = JSON.parse(readFileSync(o.manifestPath, 'utf8'))
  if (!manifest?.id || !Array.isArray(manifest.tickets)) throw new Error('Not a VYBE manifest')
  // The manifest carries the server's clock; the offset is kept with the state so a restart does not reset the clock.
  const state = existsSync(o.statePath) ? JSON.parse(readFileSync(o.statePath, 'utf8')) : {}
  if (state.manifest !== manifest.id) { state.manifest = manifest.id; state.offset = manifest.server_epoch * 1000 - now(); state.devices = {} }
  const saveState = () => writeFileSync(o.statePath, JSON.stringify(state))
  saveState()
  const serverNow = () => now() + state.offset

  // The ledger: one JSON line per decision. Replayed on start, so a crash or power cut loses nothing that was answered.
  const seen = new Set(), byRequest = new Map(); let seq = 0
  if (existsSync(o.ledgerPath)) for (const line of readFileSync(o.ledgerPath, 'utf8').split('\n')) {
    if (!line.trim()) continue
    const r = JSON.parse(line)
    if (r.manifest !== manifest.id) continue
    seq = Math.max(seq, r.seq)
    if (r.decision === 'ACCEPTED' && r.ticket) seen.add(r.ticket)
    if (r.request) byRequest.set(`${r.device}:${r.request}`, r)
  }
  const fd = openSync(o.ledgerPath, 'a')
  const append = r => { writeSync(fd, JSON.stringify(r) + '\n'); fsyncSync(fd) }

  const failedPins = new Map()
  const deviceOf = req => {
    const tok = (req.headers.authorization ?? '').replace(/^Bearer /, '')
    for (const [id, d] of Object.entries(state.devices)) {
      const a = Buffer.from(d.token), b = Buffer.from(tok.padEnd(d.token.length).slice(0, d.token.length))
      if (tok.length === d.token.length && timingSafeEqual(a, b) && !d.revoked) return { id, ...d }
    }
    return null
  }
  const body = req => new Promise((res, rej) => { let s = ''; req.on('data', c => { s += c; if (s.length > 10_000) { rej(new Error('too large')); req.destroy() } }); req.on('end', () => { try { res(s ? JSON.parse(s) : {}) } catch (e) { rej(e) } }) })
  const send = (res, status, obj) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(obj)) }

  // Decisions are made one at a time (Node runs this handler on one thread and nothing below awaits between reading the
  // ledger state and writing to it, except the hash check, which is guarded by the in-flight set).
  const inflight = new Set()
  async function scan(device, credential, request) {
    const key = `${device.id}:${request}`
    if (byRequest.has(key)) return { ...byRequest.get(key), replay: true }
    const r = await judgeOffline(String(credential ?? ''), manifest, seen, serverNow())
    const tid = r.ticket?.t ?? null
    let decision = r.decision
    if (decision === 'ACCEPTED' && (seen.has(tid) || inflight.has(tid))) decision = 'ALREADY_USED'
    if (decision === 'ACCEPTED') inflight.add(tid)
    try {
      const rec = { id: randomUUID(), seq: ++seq, at: new Date(serverNow()).toISOString(), decision, ticket: tid, ref: r.ticket?.r ?? null, type: r.ticket?.n ?? null,
                    zones: r.ticket?.z ?? [], seat: r.ticket?.s ?? null, reason: r.reason ?? null, manifest: manifest.id, manifest_issued_at: manifest.issued_at,
                    device: device.id, device_label: device.label, request }
      append(rec)
      if (decision === 'ACCEPTED') seen.add(tid)
      byRequest.set(key, rec)
      return rec
    } finally { inflight.delete(tid) }
  }

  async function handle(req, res) {
    try {
      const url = new URL(req.url, 'http://gate')
      if (req.method === 'GET' && url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:" }); return res.end(PAGE) }
      if (req.method === 'GET' && url.pathname === '/health') {
        return send(res, 200, { event: manifest.event.title, gate: manifest.gate, manifest: manifest.id, valid_until: manifest.valid_until, expired: serverNow() > Date.parse(manifest.valid_until),
                                tickets: manifest.tickets.length, admitted: seen.size, decisions: seq, devices: Object.values(state.devices).filter(d => !d.revoked).length })
      }
      if (req.method === 'POST' && url.pathname === '/pair') {
        const ip = req.socket.remoteAddress ?? '?'
        const f = failedPins.get(ip) ?? { n: 0, until: 0 }
        if (f.until > now()) return send(res, 429, { error: 'Too many wrong PINs. Wait 5 minutes.' })
        const b = await body(req)
        if (String(b.pin ?? '') !== o.pin) { f.n++; if (f.n >= 5) { f.until = now() + 5 * 60_000; f.n = 0 } failedPins.set(ip, f); return send(res, 403, { error: 'Wrong PIN' }) }
        if (Object.values(state.devices).filter(d => !d.revoked).length >= (o.maxDevices ?? 20)) return send(res, 403, { error: 'Device limit reached' })
        const id = randomUUID(), token = randomBytes(32).toString('hex')
        state.devices[id] = { token, label: String(b.label ?? 'phone').slice(0, 40), paired_at: new Date(now()).toISOString() }
        saveState()
        return send(res, 200, { device: id, token, event: manifest.event.title, gate: manifest.gate })
      }
      if (req.method === 'POST' && url.pathname === '/scan') {
        const d = deviceOf(req); if (!d) return send(res, 401, { error: 'Pair this phone first' })
        const b = await body(req)
        if (typeof b.request !== 'string' || !/^[0-9a-f-]{36}$/i.test(b.request)) return send(res, 400, { error: 'request id required' })
        return send(res, 200, await scan(d, b.credential, b.request))
      }
      // Supervisor: the ledger in the format VYBE's offline_sync takes, and device revocation. Admin PIN required.
      if (url.pathname === '/export' || url.pathname === '/revoke') {
        if ((req.headers['x-admin-pin'] ?? '') !== o.adminPin) return send(res, 403, { error: 'Admin PIN required' })
        if (url.pathname === '/revoke' && req.method === 'POST') { const b = await body(req); if (state.devices[b.device]) { state.devices[b.device].revoked = true; saveState() } return send(res, 200, { ok: true }) }
        const items = readFileSync(o.ledgerPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => r.manifest === manifest.id)
          .map(r => ({ id: r.id, seq: r.seq, at: r.at, decision: r.decision === 'MANIFEST_EXPIRED' ? 'INVALID' : r.decision, ticket: r.ticket, manifest: r.manifest, manifest_issued_at: r.manifest_issued_at }))
        return send(res, 200, { manifest: manifest.id, event: manifest.event, items })
      }
      send(res, 404, { error: 'Not found' })
    } catch (e) { send(res, 400, { error: 'Bad request' }) }
  }
  const server = o.tls ? httpsServer(o.tls, handle) : httpServer(handle)
  server.on('close', () => { try { closeSync(fd) } catch { /* already closed */ } })
  return server
}

// Run directly: node local-gate/gate.mjs  (see local-gate/README.md)
if (import.meta.url === `file://${process.argv[1]}`) {
  const env = process.env
  const tls = env.TLS_CERT && env.TLS_KEY ? { cert: readFileSync(env.TLS_CERT), key: readFileSync(env.TLS_KEY) } : null
  const gate = createGate({ manifestPath: env.MANIFEST ?? 'manifest.json', ledgerPath: env.LEDGER ?? 'ledger.jsonl', statePath: env.STATE ?? 'gate-state.json',
                            pin: env.PAIRING_PIN ?? '', adminPin: env.ADMIN_PIN ?? '', maxDevices: Number(env.MAX_DEVICES ?? 20), tls })
  const port = Number(env.PORT ?? (tls ? 8443 : 8080))
  gate.listen(port, '0.0.0.0', () => console.log(`VYBE local gate on ${tls ? 'https' : 'http'}://<this computer's address>:${port}${tls ? '' : '  (no TLS: phone cameras need HTTPS; typed codes still work)'}`))
}
