/**
 * QR scanning that works on every browser: the native BarcodeDetector where it exists (fast), otherwise jsQR on canvas frames
 * (a small pure-JS decoder, loaded only when needed). Both return the raw text of the first QR code in the frame.
 */
export type FrameScanner = (video: HTMLVideoElement) => Promise<string | null>

/** Decodes a QR code from raw RGBA pixels. Pure, so it is unit-tested. */
export async function decodeQrFromRgba(data: Uint8ClampedArray, width: number, height: number): Promise<string | null> {
  const { default: jsQR } = await import('jsqr')
  return jsQR(data, width, height, { inversionAttempts: 'dontInvert' })?.data ?? null
}

export async function createFrameScanner(): Promise<{ scan: FrameScanner; engine: 'native' | 'jsqr' }> {
  const BD = (globalThis as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => { detect(v: HTMLVideoElement): Promise<{ rawValue: string }[]> } }).BarcodeDetector
  if (BD) {
    try { const det = new BD({ formats: ['qr_code'] }); return { engine: 'native', scan: async v => (await det.detect(v).catch(() => []))[0]?.rawValue ?? null } } catch { /* fall through to jsQR */ }
  }
  const canvas = document.createElement('canvas'); const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  return {
    engine: 'jsqr',
    scan: async v => {
      if (!v.videoWidth) return null
      const w = Math.min(640, v.videoWidth), h = Math.round((w * v.videoHeight) / v.videoWidth)       // downscale: faster, plenty for a ticket QR
      canvas.width = w; canvas.height = h; ctx.drawImage(v, 0, 0, w, h)
      return decodeQrFromRgba(ctx.getImageData(0, 0, w, h).data, w, h)
    },
  }
}
