import type { Conditions, DataMode } from './dataMode'

/**
 * Live video quality. A profile is what the broadcaster's browser is ASKED to capture and encode; what it actually captures,
 * what each simulcast layer really sends and what a viewer really receives are measured separately (see readLiveStats) and
 * are the only numbers shown as achieved. LiveKit publishes the top layer plus smaller simulcast layers, and each viewer is
 * sent the layer that fits their screen and connection (adaptiveStream + dynacast); a weak network steps down by itself.
 */
export type ProfileId = 'fhd' | 'hd' | 'sd' | 'low'
export interface Profile { id: ProfileId; label: string; short: string; width: number; height: number; fps: number; maxBitrate: number; layers: ProfileId[] }
export const PROFILES: Record<ProfileId, Profile> = {
  fhd: { id: 'fhd', label: 'Full HD (1080p)', short: '1080p', width: 1920, height: 1080, fps: 30, maxBitrate: 3_000_000, layers: ['low', 'hd'] },
  hd: { id: 'hd', label: 'HD (720p)', short: '720p', width: 1280, height: 720, fps: 30, maxBitrate: 1_700_000, layers: ['low', 'sd'] },
  sd: { id: 'sd', label: 'Standard (480p)', short: '480p', width: 854, height: 480, fps: 30, maxBitrate: 900_000, layers: ['low'] },
  low: { id: 'low', label: 'Data saver (360p)', short: '360p', width: 640, height: 360, fps: 24, maxBitrate: 450_000, layers: [] },
}
export type LivePref = 'auto' | ProfileId

/**
 * The profile to request. "auto" uses the device's data mode and what the browser reports about the device and the
 * network: Full HD only on a capable device without data saver; HD on mid-range devices; less on slow or saver links.
 */
export function chooseProfile(pref: LivePref, mode: DataMode, c: Conditions): ProfileId {
  if (pref !== 'auto') return pref
  const slow2g = /(^|-)2g$/.test(c.effectiveType)
  if (mode === 'saver' || (mode === 'auto' && (c.saveData || slow2g))) return slow2g ? 'low' : 'sd'
  if (c.effectiveType === '3g') return 'sd'
  const weak = mode === 'device' || (c.memoryGb != null && c.memoryGb <= 2) || c.cores <= 2
  if (weak) return 'hd'
  const mid = (c.memoryGb != null && c.memoryGb <= 4) || c.cores <= 4
  if (mid && mode !== 'high') return 'hd'
  return 'fhd'
}

/** Phones held upright capture portrait video: ask for the portrait shape so the camera does not crop a landscape frame. */
export const captureSize = (p: Profile, portrait: boolean) => (portrait ? { width: p.height, height: p.width } : { width: p.width, height: p.height })

/* ------------------------------------------------------------- measuring what really happens */
export interface LayerStat { rid: string; width: number; height: number; fps: number; kbps: number | null; limitedBy: string | null; paused?: boolean }
export interface LiveStats {
  at: number
  capture: { width: number; height: number } | null           // the camera track's real size (broadcaster)
  sent: LayerStat[]                                            // each simulcast layer as encoded (broadcaster)
  received: { width: number; height: number; fps: number | null; kbps: number | null; lossPct: number | null; jitterMs: number | null; dropped: number | null } | null
  rttMs: number | null
}
type Sample = { at: number; bytes: Map<string, number>; frames: number | null; recvBytes: number | null; lost: number | null; recv: number | null }

/**
 * Turns two snapshots of WebRTC statistics into rates. Pure (no browser objects), so it is unit-tested; the LiveKit-specific
 * reading lives in readLiveStats.
 */
export function summarize(prev: Sample | null, cur: Sample, raw: { capture: LiveStats['capture']; layers: { rid: string; width: number; height: number; fps: number; bytes: number; limitedBy?: string }[]; received: { width?: number; height?: number; framesDecoded?: number; dropped?: number; jitter?: number } | null; rttMs: number | null }): LiveStats {
  const dt = prev ? (cur.at - prev.at) / 1000 : 0
  const rate = (now: number, before: number | undefined | null) => (prev && dt > 0 && before != null && now >= before ? Math.round(((now - before) * 8) / dt / 1000) : null)
  const sent = raw.layers.map(l => ({ rid: l.rid || 'single', width: l.width, height: l.height, fps: Math.round(l.fps || 0), kbps: rate(l.bytes, prev?.bytes.get(l.rid)), limitedBy: l.limitedBy && l.limitedBy !== 'none' ? l.limitedBy : null }))
    .sort((a, b) => b.height - a.height)
  let received: LiveStats['received'] = null
  if (raw.received && raw.received.width && raw.received.height) {
    const fps = prev && dt > 0 && cur.frames != null && prev.frames != null ? Math.round((cur.frames - prev.frames) / dt) : null
    const lostD = prev && cur.lost != null && prev.lost != null ? cur.lost - prev.lost : null
    const recvD = prev && cur.recv != null && prev.recv != null ? cur.recv - prev.recv : null
    received = {
      width: raw.received.width, height: raw.received.height, fps,
      kbps: rate(cur.recvBytes ?? 0, prev?.recvBytes),
      lossPct: lostD != null && recvD != null && lostD + recvD > 0 ? Math.round((lostD / (lostD + recvD)) * 1000) / 10 : null,
      jitterMs: raw.received.jitter != null ? Math.round(raw.received.jitter * 1000) : null,
      dropped: raw.received.dropped ?? null,
    }
  }
  return { at: cur.at, capture: raw.capture, sent, received, rttMs: raw.rttMs }
}

/** Minimal shapes of the LiveKit objects read here (kept structural so this file does not load the SDK). */
interface LocalVideoLike { dimensions?: { width: number; height: number }; getSenderStats(): Promise<{ rid: string; frameWidth: number; frameHeight: number; framesPerSecond: number; bytesSent?: number; qualityLimitationReason?: string; roundTripTime?: number }[]> }
interface RemoteVideoLike { getReceiverStats(): Promise<{ frameWidth?: number; frameHeight?: number; framesDecoded: number; framesDropped: number; packetsLost?: number; packetsReceived?: number; bytesReceived?: number; jitter?: number } | undefined> }

/** Reads one snapshot from the broadcaster's camera track or a viewer's received track. Never throws. */
export async function readLiveStats(local: LocalVideoLike | null, remote: RemoteVideoLike | null, prev: Sample | null): Promise<{ stats: LiveStats; sample: Sample }> {
  const at = Date.now()
  const layers: { rid: string; width: number; height: number; fps: number; bytes: number; limitedBy?: string }[] = []
  let rtt: number | null = null
  const paused: string[] = []
  if (local) {
    const s = await local.getSenderStats().catch(() => [])
    for (const l of s) {
      // A layer nobody needs right now is paused by the server (dynacast) and sends no frames: listed as paused, not as sent.
      if (!l.frameWidth || !l.frameHeight) { paused.push(l.rid); continue }
      layers.push({ rid: l.rid, width: l.frameWidth, height: l.frameHeight, fps: l.framesPerSecond, bytes: l.bytesSent ?? 0, limitedBy: l.qualityLimitationReason })
      if (l.roundTripTime != null) rtt = Math.round(l.roundTripTime * 1000)
    }
  }
  const r = remote ? await remote.getReceiverStats().catch(() => undefined) : undefined
  const sample: Sample = { at, bytes: new Map(layers.map(l => [l.rid, l.bytes])), frames: r?.framesDecoded ?? null, recvBytes: r?.bytesReceived ?? null, lost: r?.packetsLost ?? null, recv: r?.packetsReceived ?? null }
  const stats = summarize(prev, sample, {
    capture: local?.dimensions ? { width: local.dimensions.width, height: local.dimensions.height } : null,
    layers, rttMs: rtt,
    received: r ? { width: r.frameWidth, height: r.frameHeight, framesDecoded: r.framesDecoded, dropped: r.framesDropped, jitter: r.jitter } : null,
  })
  stats.sent.push(...paused.map(rid => ({ rid, width: 0, height: 0, fps: 0, kbps: null, limitedBy: null, paused: true })))
  return { stats, sample }
}

/** "1080 × 1920" style label for a measured size, with the common name of its shorter side. */
export function sizeLabel(s: { width: number; height: number } | null | undefined): string {
  if (!s) return 'not measured yet'
  const short = Math.min(s.width, s.height)
  return `${s.width} × ${s.height} (${short}p)`
}
