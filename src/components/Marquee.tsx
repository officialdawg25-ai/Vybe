import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react'

/**
 * One line of text that scrolls like Instagram's audio label when (and only when) it does not fit: it loops with a gap,
 * fades at the edges, and a short text just sits still. `prefers-reduced-motion` keeps a plain ellipsis instead.
 */
export function Marquee({ children, className = '' }: { children: string; className?: string }) {
  const box = useRef<HTMLSpanElement>(null)
  const [run, setRun] = useState<{ shift: number; dur: number } | null>(null)
  useLayoutEffect(() => {
    const el = box.current; if (!el) return
    const measure = () => {
      const one = el.querySelector<HTMLElement>('.mq-in'); if (!one) return
      const text = one.firstElementChild as HTMLElement | null, w = text?.offsetWidth ?? 0
      setRun(w > el.clientWidth + 2 ? { shift: w + 32, dur: Math.max(6, (w + 32) / 34) } : null)   // ~34 px per second
    }
    measure()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    ro?.observe(el)
    return () => ro?.disconnect()
  }, [children])
  return (
    <span ref={box} className={`mq${run ? ' run' : ''} ${className}`} style={run ? ({ '--mq-shift': `-${run.shift}px`, '--mq-dur': `${run.dur}s` } as CSSProperties) : undefined} title={children}>
      <span className="mq-track">
        <span className="mq-in"><span className="mq-t">{children}</span></span>
        {run && <span className="mq-in" aria-hidden><span className="mq-t">{children}</span></span>}
      </span>
    </span>
  )
}
