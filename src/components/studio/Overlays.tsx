import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Check, Search, Sparkles, Trash2, Undo2, X } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { INK, STICKERS, TEXT_STYLES, newId, thinStroke, type DrawOverlay, type Overlay, type Placed, type TextOverlay, type TextStyle } from '../../lib/studio'
import { Avatar, Spinner } from '../../ui'
import type { PublicProfile } from '../../lib/types'

const pct = (n: number) => `${(n * 100).toFixed(2)}%`

/** Width of an element in CSS pixels, kept current. */
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [w, setW] = useState(360)
  useEffect(() => {
    const el = ref.current; if (!el) return
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width || 360)); ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, w] as const
}

/**
 * Text, stickers, @mentions and drawing over a photo, video or text card. Read-only in the viewer (mentions open the
 * profile); in the studio, items can be dragged, pinched or scrolled to resize, tapped to edit, and dropped on the bin.
 */
export function OverlayLayer({ items, editable = false, onChange, onEditText, onDragging }: { items: Overlay[]; editable?: boolean; onChange?: (o: Overlay[]) => void; onEditText?: (o: TextOverlay) => void; onDragging?: (on: boolean) => void }) {
  const [ref, w] = useWidth<HTMLDivElement>()
  const [drag, setDrag] = useState<string | null>(null)
  const [overBin, setOverBin] = useState(false)
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const start = useRef<{ id: string; x: number; y: number; ox: number; oy: number; size: number; dist: number; moved: boolean } | null>(null)
  const draws = items.filter((o): o is DrawOverlay => o.t === 'draw')
  const placed = items.filter((o): o is Placed => o.t !== 'draw')
  const set = (id: string, patch: Partial<Placed>) => onChange?.(items.map(o => (o.id === id ? ({ ...o, ...patch } as Overlay) : o)))

  const down = (e: React.PointerEvent, o: Placed) => {
    if (!editable) return
    e.stopPropagation(); (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const pts = [...pointers.current.values()]
    start.current = { id: o.id, x: e.clientX, y: e.clientY, ox: o.x, oy: o.y, size: o.size, dist: pts.length > 1 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0, moved: false }
  }
  const move = (e: React.PointerEvent) => {
    const s = start.current, el = ref.current; if (!s || !el || !pointers.current.has(e.pointerId)) return
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const r = el.getBoundingClientRect(), pts = [...pointers.current.values()]
    if (pts.length > 1 && s.dist) { set(s.id, { size: Math.min(3, Math.max(0.4, s.size * (Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) / s.dist))) }); s.moved = true; return }
    const dx = e.clientX - s.x, dy = e.clientY - s.y
    if (!s.moved && Math.hypot(dx, dy) < 6) return
    if (!s.moved) { s.moved = true; setDrag(s.id); onDragging?.(true) }
    set(s.id, { x: Math.min(1, Math.max(0, s.ox + dx / r.width)), y: Math.min(1, Math.max(0, s.oy + dy / r.height)) })
    setOverBin(e.clientY > r.bottom - 90 && Math.abs(e.clientX - (r.left + r.width / 2)) < 60)
  }
  const up = (e: React.PointerEvent, o: Placed) => {
    pointers.current.delete(e.pointerId)
    const s = start.current
    if (pointers.current.size) return
    start.current = null; setDrag(null); onDragging?.(false)
    if (s && overBin) { onChange?.(items.filter(x => x.id !== s.id)); setOverBin(false); return }
    setOverBin(false)
    if (s && !s.moved && o.t === 'text') onEditText?.(o)
  }
  const wheel = (e: React.WheelEvent, o: Placed) => { if (!editable) return; set(o.id, { size: Math.min(3, Math.max(0.4, o.size * (e.deltaY < 0 ? 1.08 : 0.93))) }) }

  return (
    <div ref={ref} className={`ov${editable ? ' edit' : ''}`}>
      {draws.length > 0 && (
        <svg className="ov-draw" viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-hidden>
          {draws.map(d => <polyline key={d.id} points={pairs(d.pts)} fill="none" stroke={d.color} strokeWidth={d.width * (w / 400)} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" style={d.glow ? { filter: `drop-shadow(0 0 6px ${d.color})` } : undefined} />)}
        </svg>
      )}
      {placed.map(o => {
        const style: React.CSSProperties = { left: pct(o.x), top: pct(o.y), fontSize: `${(w * 0.06 * o.size).toFixed(1)}px` }
        const common = { key: o.id, style, onPointerDown: (e: React.PointerEvent) => down(e, o), onPointerMove: move, onPointerUp: (e: React.PointerEvent) => up(e, o), onPointerCancel: (e: React.PointerEvent) => up(e, o), onWheel: (e: React.WheelEvent) => wheel(e, o) }
        const cls = drag === o.id ? ' dragging' : ''
        if (o.t === 'sticker') return <span {...common} className={`ov-item ov-sticker${/[A-Za-z0-9]/.test(o.emoji) ? ' word' : ''}${cls}`}>{o.emoji}</span>
        if (o.t === 'mention') return editable
          ? <span {...common} className={`ov-item ov-mention${cls}`}>@{o.username}</span>
          : <Link key={o.id} to={`/app/u/${o.username}`} className="ov-item ov-mention" style={style} onPointerDown={e => e.stopPropagation()} onPointerUp={e => e.stopPropagation()}>@{o.username}</Link>
        return <span {...common} className={`ov-item ov-text s-${o.style}${o.bg ? ' bg' : ''}${cls}`} style={{ ...style, color: o.color, ...(o.style === 'neon' ? { textShadow: `0 0 .35em ${o.color}, 0 0 .9em ${o.color}` } : {}) }}>{o.text}</span>
      })}
      {editable && drag && <span className={`ov-bin${overBin ? ' hot' : ''}`} aria-hidden><Trash2 size={22} /></span>}
    </div>
  )
}
const pairs = (p: number[]) => { const out: string[] = []; for (let i = 0; i + 1 < p.length; i += 2) out.push(`${p[i]},${p[i + 1]}`); return out.join(' ') }

/* ------------------------------------------------------------------ text */
export function TextEditor({ initial, onDone, onCancel }: { initial?: TextOverlay | null; onDone: (o: TextOverlay | null) => void; onCancel: () => void }) {
  const [text, setText] = useState(initial?.text ?? '')
  const [color, setColor] = useState(initial?.color ?? '#ffffff')
  const [style, setStyle] = useState<TextStyle>(initial?.style ?? 'classic')
  const [bg, setBg] = useState(initial?.bg ?? false)
  const [size, setSize] = useState(initial?.size ?? 1)
  const done = () => {
    const t = text.trim()
    if (!t) return onDone(null)
    onDone({ t: 'text', id: initial?.id ?? newId(), text: t.slice(0, 300), x: initial?.x ?? 0.5, y: initial?.y ?? 0.42, size, color, style, bg })
  }
  return (
    <div className="ste" role="dialog" aria-modal="true" aria-label="Add text">
      <div className="ste-top">
        <button className="ste-btn" aria-label="Cancel" onClick={onCancel}><X size={24} /></button>
        <button className={`ste-pill${bg ? ' on' : ''}`} aria-pressed={bg} onClick={() => setBg(b => !b)}>A<span className="sr-only"> Background</span></button>
        <button className="ste-done" onClick={done}>Done</button>
      </div>
      <div className="ste-mid">
        <input type="range" className="ste-size" min={0.5} max={2.6} step={0.05} value={size} onChange={e => setSize(Number(e.target.value))} aria-label="Text size" />
        <textarea autoFocus className={`ste-input ov-text s-${style}${bg ? ' bg' : ''}`} style={{ color, fontSize: `${1.9 * size}rem`, ...(style === 'neon' ? { textShadow: `0 0 .35em ${color}, 0 0 .9em ${color}` } : {}) }} value={text} maxLength={300} placeholder="Type something" aria-label="Your text" onChange={e => setText(e.target.value)} />
      </div>
      <div className="ste-bottom">
        <div className="ste-styles" role="group" aria-label="Font">{TEXT_STYLES.map(s => <button key={s.key} className={`ste-style s-${s.key}${style === s.key ? ' on' : ''}`} aria-pressed={style === s.key} onClick={() => setStyle(s.key)}>{s.label}</button>)}</div>
        <div className="ste-inks" role="group" aria-label="Colour">{INK.map(c => <button key={c} className={`ste-ink${color === c ? ' on' : ''}`} style={{ background: c }} aria-pressed={color === c} aria-label={`Colour ${c}`} onClick={() => setColor(c)} />)}</div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ drawing */
export function DrawPad({ items, onChange, onDone }: { items: Overlay[]; onChange: (o: Overlay[]) => void; onDone: () => void }) {
  const [color, setColor] = useState('#ffffff')
  const [width, setWidth] = useState(6)
  const [glow, setGlow] = useState(false)
  const [live, setLive] = useState<number[] | null>(null)
  const pad = useRef<HTMLDivElement>(null)
  const pt = (e: React.PointerEvent) => { const r = pad.current!.getBoundingClientRect(); return [Math.round(((e.clientX - r.left) / r.width) * 1000), Math.round(((e.clientY - r.top) / r.height) * 1000)] }
  const strokes = items.filter(o => o.t === 'draw').length
  const finish = () => { if (live && live.length >= 4) onChange([...items, { t: 'draw', id: newId(), color, width, glow, pts: thinStroke(live) }]); setLive(null) }
  return (
    <div className="dp" role="dialog" aria-label="Draw">
      <div className="dp-top">
        <button className="ste-btn" aria-label="Undo last stroke" disabled={!strokes} onClick={() => { const i = items.map(o => o.t).lastIndexOf('draw'); if (i >= 0) onChange(items.filter((_, k) => k !== i)) }}><Undo2 size={22} /></button>
        <button className={`ste-pill${glow ? ' on' : ''}`} aria-pressed={glow} onClick={() => setGlow(g => !g)}><Sparkles size={16} aria-hidden /> Neon</button>
        <button className="ste-done" onClick={onDone}><Check size={18} aria-hidden /> Done</button>
      </div>
      <div ref={pad} className="dp-pad" onPointerDown={e => { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); setLive(pt(e)) }} onPointerMove={e => live && setLive(l => (l ? [...l, ...pt(e)] : l))} onPointerUp={finish} onPointerCancel={finish}>
        {live && <svg viewBox="0 0 1000 1000" preserveAspectRatio="none" className="ov-draw" aria-hidden><polyline points={pairs(live)} fill="none" stroke={color} strokeWidth={width * ((pad.current?.clientWidth ?? 360) / 400)} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" style={glow ? { filter: `drop-shadow(0 0 6px ${color})` } : undefined} /></svg>}
      </div>
      <div className="dp-bottom">
        <input type="range" min={2} max={24} value={width} onChange={e => setWidth(Number(e.target.value))} aria-label="Brush size" className="dp-width" />
        <div className="ste-inks" role="group" aria-label="Colour">{INK.map(c => <button key={c} className={`ste-ink${color === c ? ' on' : ''}`} style={{ background: c }} aria-pressed={color === c} aria-label={`Colour ${c}`} onClick={() => setColor(c)} />)}</div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ stickers & mentions */
export function StickerSheet({ onPick, onClose }: { onPick: (emoji: string) => void; onClose: () => void }) {
  const now = new Date()
  const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(now)
  const day = new Intl.DateTimeFormat(undefined, { weekday: 'long' }).format(now)
  return (
    <StudioSheet title="Stickers" onClose={onClose}>
      <div className="stk-quick">
        <button className="stk-word" onClick={() => onPick(`🕒 ${time}`)}>{time}</button>
        <button className="stk-word" onClick={() => onPick(day.toUpperCase())}>{day.toUpperCase()}</button>
        <button className="stk-word" onClick={() => onPick('GOOD VYBES')}>GOOD VYBES</button>
      </div>
      <div className="stk-grid">{STICKERS.map(s => <button key={s} className="stk" aria-label={`Sticker ${s}`} onClick={() => onPick(s)}>{s}</button>)}</div>
    </StudioSheet>
  )
}

export function MentionSheet({ onPick, onClose }: { onPick: (p: PublicProfile) => void; onClose: () => void }) {
  const [q, setQ] = useState('')
  const [rows, setRows] = useState<PublicProfile[] | null>([])
  useEffect(() => {
    const term = q.trim().replace(/^@/, '').replace(/[^\w. -]/g, '')
    if (term.length < 2) { setRows([]); return }
    let live = true; setRows(null)
    const t = setTimeout(async () => {
      const { data } = await supabase.from('profiles').select('id,username,display_name,avatar_path').or(`username.ilike.${term}%,display_name.ilike.%${term}%`).limit(20)
      if (live) setRows((data ?? []) as PublicProfile[])
    }, 250)
    return () => { live = false; clearTimeout(t) }
  }, [q])
  return (
    <StudioSheet title="Mention someone" onClose={onClose}>
      <label className="ms-search"><Search size={20} aria-hidden /><input autoFocus type="search" aria-label="Search people" placeholder="Search people" value={q} onChange={e => setQ(e.target.value)} /></label>
      {rows === null ? <Spinner /> : !rows.length ? <p className="ms-fine" style={{ padding: 12 }}>{q.trim().length < 2 ? 'Type at least two letters of a name or @username.' : 'Nobody matches.'}</p> : (
        <ul className="ms-list">{rows.map(p => (
          <li key={p.id}><button className="ms-person" onClick={() => onPick(p)}><Avatar path={p.avatar_path} name={p.display_name || p.username} /><span className="grow"><b className="clamp-1">{p.display_name || p.username}</b><span className="clamp-1">@{p.username}</span></span></button></li>))}</ul>
      )}
    </StudioSheet>
  )
}

/** Dark bottom sheet used across the studio. */
export function StudioSheet({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose(); document.addEventListener('keydown', k); return () => document.removeEventListener('keydown', k) }, [onClose])
  return (
    <div className="ss" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className={`ss-panel${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="ms-grab" aria-hidden />
        <h2 className="ss-title">{title}</h2>
        <div className="ss-body">{children}</div>
      </div>
    </div>
  )
}
