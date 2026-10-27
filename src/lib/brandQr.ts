import QRCode from 'qrcode'
import { WORDMARK } from '../brand/logoPaths.ts'

/**
 * The VYBE ticket QR: an ordinary QR code that any phone or door scanner reads, dressed in the brand. Error correction is
 * level H (about 30 % of the code can be lost and still decode), which pays for a clear centre holding a standalone V.
 * The centre takes well under 10 % of the modules, the three finder "eyes" keep their exact 7×7 geometry (only their
 * corners are rounded) and the quiet zone stays white, so contrast and timing are untouched. Checked by decoding the
 * rendered image in a real browser (scripts/qr-check.mts), and as robust as a plain level-M code of the same size.
 */
export interface QrStyle { ink?: string; eye?: string; accent?: string; accent2?: string; quiet?: number; dot?: number; round?: number; version?: number; hole?: number }

export function qrMatrix(text: string, version?: number) {
  const q = QRCode.create(text, { errorCorrectionLevel: 'H', ...(version ? { version } : {}) })
  const n = q.modules.size
  const data = q.modules.data as Uint8Array
  return { n, version: q.version, dark: (r: number, c: number) => data[r * n + c] === 1 }
}

/** Size of the clear centre, in modules: odd, about a fifth of the side. */
export const holeSize = (n: number) => { const k = Math.max(5, Math.round(n * 0.22)); return k % 2 ? k : k + 1 }

const inFinder = (r: number, c: number, n: number) => (r < 7 && c < 7) || (r < 7 && c >= n - 7) || (r >= n - 7 && c < 7)

const LV = WORDMARK.letters[0]
/** The official V's own box (its path starts at 0,0 and is LV.w wide, 268.2 tall). */
export const V_BOX = { w: LV.w, h: 268.2, d: LV.d }

/** Everything but the centre mark, plus where the centre goes. The live ticket animates the V; the static image just fills it. */
export function brandedQrParts(text: string, s: QrStyle = {}) {
  const ink = s.ink ?? '#140d2e', eye = s.eye ?? '#4b2fd6'
  const quiet = s.quiet ?? 1
  const { n, dark } = qrMatrix(text, s.version)
  const k = s.hole ?? holeSize(n), h0 = (n - k) / 2, h1 = h0 + k
  const inHole = (r: number, c: number) => r >= h0 - 0.5 && r < h1 && c >= h0 - 0.5 && c < h1
  const W = n + quiet * 2
  const dots: string[] = []
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    if (!dark(r, c) || inFinder(r, c, n) || inHole(r, c)) continue
    const d = s.dot ?? 1, o = (1 - d) / 2, rr = Math.min(s.round ?? 0.3, d / 2), e = d - 2 * rr
    dots.push(rr ? `M${c + quiet + o + rr} ${r + quiet + o}h${e}a${rr} ${rr} 0 0 1 ${rr} ${rr}v${e}a${rr} ${rr} 0 0 1-${rr} ${rr}h-${e}a${rr} ${rr} 0 0 1-${rr}-${rr}v-${e}a${rr} ${rr} 0 0 1 ${rr}-${rr}z`
      : `M${c + quiet + o} ${r + quiet + o}h${d}v${d}h-${d}z`)
  }
  const eyeAt = (r: number, c: number) => {
    const x = c + quiet, y = r + quiet
    return `<path d="M${x + 1.6} ${y}h3.8a1.6 1.6 0 0 1 1.6 1.6v3.8a1.6 1.6 0 0 1-1.6 1.6h-3.8a1.6 1.6 0 0 1-1.6-1.6v-3.8a1.6 1.6 0 0 1 1.6-1.6zM${x + 1.9} ${y + 1}a0.9 0.9 0 0 0-0.9 0.9v3.2a0.9 0.9 0 0 0 0.9 0.9h3.2a0.9 0.9 0 0 0 0.9-0.9v-3.2a0.9 0.9 0 0 0-0.9-0.9z" fill="${eye}" fill-rule="evenodd"/>`
      + `<rect x="${x + 2}" y="${y + 2}" width="3" height="3" rx="0.9" fill="${ink}"/>`
  }
  const c = quiet + n / 2, tile = k - 0.6
  // The official V, fitted inside the tile with a little air; centred.
  const vw = tile * 0.64, sc = vw / V_BOX.w, vh = V_BOX.h * sc
  return {
    W, quiet,
    body: `<rect width="${W}" height="${W}" rx="${quiet * 0.9}" fill="#fff"/><path d="${dots.join('')}" fill="${ink}"/>` + eyeAt(0, 0) + eyeAt(0, n - 7) + eyeAt(n - 7, 0),
    tile: { x: c - tile / 2, y: c - tile / 2, size: tile, rx: tile * 0.26 },
    v: { x: c - vw / 2, y: c - vh / 2, scale: sc },
  }
}

export function brandedQrSvg(text: string, s: QrStyle = {}): string {
  const a1 = s.accent ?? '#6a4cff', a2 = s.accent2 ?? '#c04cff'
  const p = brandedQrParts(text, s)
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${p.W} ${p.W}" shape-rendering="geometricPrecision" role="img" aria-label="Ticket QR code">`
    + `<defs><linearGradient id="vg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a1}"/><stop offset="1" stop-color="${a2}"/></linearGradient></defs>`
    + p.body
    + `<rect x="${p.tile.x}" y="${p.tile.y}" width="${p.tile.size}" height="${p.tile.size}" rx="${p.tile.rx}" fill="#fff"/>`
    + `<path d="${V_BOX.d}" transform="translate(${p.v.x} ${p.v.y}) scale(${p.v.scale})" fill="url(#vg)" fill-rule="evenodd"/>`
    + `</svg>`
}
