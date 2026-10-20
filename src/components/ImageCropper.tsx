import { useEffect, useRef, useState } from 'react'
import { Sheet } from '../ui'

const SHAPES = {
  avatar: { w: 280, h: 280, ow: 1080, oh: 1080, round: true, title: 'Position your photo', cta: 'Use photo', name: 'avatar.webp' },     // on-screen crop circle and exported square (px)
  cover: { w: 320, h: 180, ow: 2400, oh: 1350, round: false, title: 'Position your cover photo', cta: 'Use cover', name: 'cover.webp' },
} as const

/**
 * Profile-photo cropper: drag to position, pinch / slider / wheel to zoom, preview inside the circle that
 * will be shown across VYBE. Exports a square WebP of exactly what is inside the circle.
 */
export function ImageCropper({ file, onDone, onCancel, shape = 'avatar' }: { file: File; onDone: (cropped: File) => void; onCancel: () => void; shape?: 'avatar' | 'cover' }) {
  const S = SHAPES[shape]
  const [url, setUrl] = useState('')
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null)
  const [zoom, setZoom] = useState(1)
  const [pos, setPos] = useState({ x: 0, y: 0 })       // image centre offset from the circle centre, in view px
  const [busy, setBusy] = useState(false)
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const pinch = useRef<{ d: number; z: number } | null>(null)

  useEffect(() => { const u = URL.createObjectURL(file); setUrl(u); return () => URL.revokeObjectURL(u) }, [file])

  const base = nat ? Math.max(S.w / nat.w, S.h / nat.h) : 1            // scale at which the image just covers the circle
  const scale = base * zoom
  const clamp = (p: { x: number; y: number }, z = zoom) => {
    if (!nat) return p
    const sw = nat.w * base * z, sh = nat.h * base * z
    const mx = Math.max(0, (sw - S.w) / 2), my = Math.max(0, (sh - S.h) / 2)
    return { x: Math.min(mx, Math.max(-mx, p.x)), y: Math.min(my, Math.max(-my, p.y)) }
  }
  const setZ = (z: number) => { const nz = Math.min(4, Math.max(1, z)); setZoom(nz); setPos(p => clamp(p, nz)) }

  const down = (e: React.PointerEvent) => { (e.target as Element).setPointerCapture(e.pointerId); pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY }) }
  const move = (e: React.PointerEvent) => {
    const prev = pointers.current.get(e.pointerId); if (!prev) return
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()]; const d = Math.hypot(a.x - b.x, a.y - b.y)
      if (pinch.current) setZ(pinch.current.z * (d / pinch.current.d)); else pinch.current = { d, z: zoom }
    } else { pinch.current = null; setPos(p => clamp({ x: p.x + e.clientX - prev.x, y: p.y + e.clientY - prev.y })) }
  }
  const up = (e: React.PointerEvent) => { pointers.current.delete(e.pointerId); if (pointers.current.size < 2) pinch.current = null }
  const key = (e: React.KeyboardEvent) => {
    const s = 12, m: Record<string, [number, number]> = { ArrowLeft: [s, 0], ArrowRight: [-s, 0], ArrowUp: [0, s], ArrowDown: [0, -s] }
    const d = m[e.key]; if (d) { e.preventDefault(); setPos(p => clamp({ x: p.x + d[0], y: p.y + d[1] })) }
    if (e.key === '+' || e.key === '=') setZ(zoom + 0.1); if (e.key === '-') setZ(zoom - 0.1)
  }

  const save = async () => {
    if (!nat || !url) return
    setBusy(true)
    try {
      const img = await createImageBitmap(file)
      const k = S.ow / S.w                                              // view px → output px
      const c = document.createElement('canvas'); c.width = S.ow; c.height = S.oh
      const g = c.getContext('2d')!
      g.imageSmoothingQuality = 'high'
      const dw = nat.w * scale * k, dh = nat.h * scale * k
      g.drawImage(img, S.ow / 2 + pos.x * k - dw / 2, S.oh / 2 + pos.y * k - dh / 2, dw, dh)
      img.close?.()
      const blob = await new Promise<Blob | null>(r => c.toBlob(r, 'image/webp', 0.9))
      if (!blob) throw new Error('Could not process the image.')
      onDone(new File([blob], S.name, { type: 'image/webp' }))
    } finally { setBusy(false) }
  }

  return (
    <Sheet title={S.title} onClose={onCancel}>
      <div className="crop-stage" style={{ width: S.w, height: S.h, borderRadius: S.round ? '50%' : 12 }} tabIndex={0} role="application"
        aria-label="Photo position. Drag, or use the arrow keys to move and plus and minus to zoom."
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onKeyDown={key}
        onWheel={e => setZ(zoom - e.deltaY * 0.002)}>
        {url && <img src={url} alt="" draggable={false} onLoad={e => setNat({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          style={nat ? { width: nat.w * scale, height: nat.h * scale, transform: `translate(calc(-50% + ${pos.x}px), calc(-50% + ${pos.y}px))` } : { visibility: 'hidden' }} />}
        <div className="crop-ring" aria-hidden style={{ borderRadius: S.round ? '50%' : 12 }} />
      </div>
      <label className="field" style={{ marginTop: 16 }}>
        <span style={{ fontWeight: 600, fontSize: '.875rem' }}>Zoom</span>
        <input type="range" min={1} max={4} step={0.01} value={zoom} onChange={e => setZ(Number(e.target.value))} />
      </label>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn ghost" onClick={onCancel} disabled={busy}>Cancel</button>
        <button className="btn primary" onClick={save} disabled={busy || !nat}>{busy ? 'Saving…' : S.cta}</button>
      </div>
    </Sheet>
  )
}
