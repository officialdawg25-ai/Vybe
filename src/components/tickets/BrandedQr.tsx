import { useId, useMemo } from 'react'
import { V_BOX, brandedQrParts } from '../../lib/brandQr'

/**
 * The VYBE ticket QR: a normal QR code (decodes like any other, see src/lib/brandQr.ts) with the official standalone V in the centre.
 * While the ticket is valid the V draws itself in the VYBE accent colours, over and over. Once the ticket is used (`spent`) the
 * animation stops for good and the V is a still, flat grey. The code itself is the short-lived signed token, so a screenshot dies.
 */
export function BrandedQr({ value, size = 220, spent = false, label = 'QR code for your ticket' }: { value: string; size?: number; spent?: boolean; label?: string }) {
  const id = useId().replace(/:/g, '')
  const p = useMemo(() => brandedQrParts(value), [value])
  const t = `translate(${p.v.x} ${p.v.y}) scale(${p.v.scale})`
  return (
    <svg className={`bqr${spent ? ' spent' : ' live'}`} viewBox={`0 0 ${p.W} ${p.W}`} width={size} height={size} role="img" aria-label={spent ? `${label} (used)` : label}
      shapeRendering="geometricPrecision">
      <defs><linearGradient id={`vg${id}`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#6a4cff" /><stop offset="1" stopColor="#c04cff" /></linearGradient></defs>
      <g dangerouslySetInnerHTML={{ __html: p.body }} />
      <rect x={p.tile.x} y={p.tile.y} width={p.tile.size} height={p.tile.size} rx={p.tile.rx} fill="#fff" />
      <g transform={t}>
        {spent
          ? <path className="bqr-v" d={V_BOX.d} fill="#a3a3ad" fillRule="evenodd" />
          : <>
              <path className="bqr-v-fill" d={V_BOX.d} fill={`url(#vg${id})`} fillRule="evenodd" />
              <path className="bqr-v-draw" d={V_BOX.d} pathLength={1} fill="none" stroke={`url(#vg${id})`} strokeWidth={9} strokeLinejoin="round" strokeLinecap="round" />
            </>}
      </g>
    </svg>
  )
}
