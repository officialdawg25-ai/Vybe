import { useMemo } from 'react'
import { brandedQrSvg } from '../../lib/brandQr'

/** The VYBE ticket QR (standalone V in the centre). Decodes like any QR code: see src/lib/brandQr.ts. */
export function BrandedQr({ value, size = 220, label = 'QR code for your ticket' }: { value: string; size?: number; label?: string }) {
  const src = useMemo(() => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(brandedQrSvg(value))}`, [value])
  return <img className="bqr" src={src} alt={label} width={size} height={size} draggable={false} />
}
