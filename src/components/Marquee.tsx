import { useLayoutEffect, useRef } from 'react'

/**
 * One line of text that, when it does not fit, slides to show its end, rests there long enough to read, slides back to the
 * start and rests again (it flips, it does not just run off to the left). A text that fits just sits still.
 * `prefers-reduced-motion` keeps a plain ellipsis.
 */
const SPEED = 38          // pixels per second
const REST = 1400         // ms the text rests at each end

export function Marquee({ children, className = '' }: { children: string; className?: string }) {
  const box = useRef<HTMLSpanElement>(null)
  const text = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    const el = box.current, t = text.current; if (!el || !t) return
    let anim: Animation | null = null
    const calm = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
    const measure = () => {
      anim?.cancel(); anim = null
      el.classList.remove('run')
      const over = t.scrollWidth - el.clientWidth
      if (calm || over <= 2 || typeof t.animate !== 'function') return
      el.classList.add('run')
      const travel = (over + 12) / SPEED * 1000, total = REST * 2 + travel * 2
      anim = t.animate([
        { transform: 'translateX(0)', offset: 0 },
        { transform: 'translateX(0)', offset: REST / total },
        { transform: `translateX(-${over + 12}px)`, offset: (REST + travel) / total },
        { transform: `translateX(-${over + 12}px)`, offset: (REST * 2 + travel) / total },
        { transform: 'translateX(0)', offset: 1 },
      ], { duration: total, iterations: Infinity, easing: 'ease-in-out' })
    }
    measure()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    ro?.observe(el)
    return () => { ro?.disconnect(); anim?.cancel() }
  }, [children])
  return (
    <span ref={box} className={`mq ${className}`} title={children}>
      <span ref={text} className="mq-t">{children}</span>
    </span>
  )
}
