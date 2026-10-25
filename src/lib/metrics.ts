import { getDataMode } from './dataMode'

/**
 * Performance samples gathered on this device: reel start-up time and stalls, live time-to-first-frame, feed timings, and
 * the page's Web Vitals. Kept in memory, bounded (the last 200 of each kind), numbers only; lab checks read them from
 * window.__vybeMetrics and summarize() gives p50/p75/p95.
 *
 * Field data: one session in four (decided once per tab) also sends a few of them to the server, through
 * record_client_metrics (migration 25), in small batches when the page is hidden or closed. Each sample is a number plus
 * coarse buckets (which screen, connection type, data mode, phone/tablet/desktop): never an id, URL, name or content.
 * Admins see percentiles only. Nothing is sent when signed out.
 */
export type MetricName = 'reel_startup_ms' | 'reel_stall' | 'reel_stall_ms' | 'live_first_frame_ms' | 'live_reconnect' | 'feed_first_page_ms' | 'feed_next_page_ms'
  | 'lcp' | 'fcp' | 'cls' | 'inp' | 'ttfb' | 'first_post'
const MAX = 200
const store = new Map<MetricName, number[]>()

/** The names the server accepts, and what each local metric is called there. */
const FIELD: Partial<Record<MetricName, string>> = {
  lcp: 'lcp', fcp: 'fcp', cls: 'cls', inp: 'inp', ttfb: 'ttfb', first_post: 'first_post',
  reel_startup_ms: 'reel_start', reel_stall_ms: 'reel_stall_ms', live_first_frame_ms: 'live_first_frame', live_reconnect: 'live_reconnect',
}

export function record(name: MetricName, value: number) {
  if (!Number.isFinite(value) || value < 0) return
  const list = store.get(name) ?? []
  list.push(name === 'cls' ? Math.round(value * 1000) / 1000 : Math.round(value))
  if (list.length > MAX) list.shift()
  store.set(name, list)
  const f = FIELD[name]
  if (f && field.on) queueField(f, list[list.length - 1])
}

export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null
  const s = [...values].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]
}
export function summarize(name: MetricName) {
  const v = store.get(name) ?? []
  return { n: v.length, p50: percentile(v, 50), p75: percentile(v, 75), p95: percentile(v, 95) }
}
export const resetMetrics = () => store.clear()

/** Coarse screen bucket for a path: the server only accepts these. */
export function routeBucket(path: string): string {
  if (path === '/app' || path === '/app/' || path.startsWith('/app/home')) return 'home'
  if (path.startsWith('/app/discover')) return 'discover'
  if (path.startsWith('/app/reels')) return 'reels'
  if (path.startsWith('/app/live')) return 'live'
  if (path.startsWith('/app/u/') || path.startsWith('/app/profile')) return 'profile'
  return 'other'
}
function context() {
  const n = navigator as Navigator & { connection?: { effectiveType?: string } }
  const et = n.connection?.effectiveType ?? ''
  const w = Math.min(screen.width, screen.height)
  return {
    r: routeBucket(location.pathname),
    c: ['4g', '3g', '2g', 'slow-2g'].includes(et) ? et : 'unknown',
    m: getDataMode(),
    d: w < 600 ? 'phone' : w < 1024 && matchMedia('(pointer: coarse)').matches ? 'tablet' : 'desktop',
  }
}

// ------------------------------------------------------------------ field sink
type Sample = { n: string; v: number; r: string; c: string; m: string; d: string }
const field: { on: boolean; queue: Sample[]; send: ((s: Sample[]) => void) | null; sent: number } = { on: false, queue: [], send: null, sent: 0 }
const PER_PAGE = 60                                   // at most this many samples leave one page load

function queueField(n: string, v: number) {
  if (field.sent + field.queue.length >= PER_PAGE) return
  field.queue.push({ n, v, ...context() })
  if (field.queue.length >= 20) flushField()
}
export function flushField() {
  if (!field.queue.length || !field.send) return
  const batch = field.queue.splice(0, 30)
  field.sent += batch.length
  field.send(batch)
}

/**
 * Starts field collection for a sampled share of sessions. `send` posts a batch (it must survive the page closing, e.g.
 * fetch with keepalive) and is a no-op while signed out. Returns whether this session is sampled.
 */
export function startFieldMetrics(send: (batch: Sample[]) => void, rate = 0.25): boolean {
  if (typeof window === 'undefined' || field.on) return field.on
  let sampled = false
  try {
    const k = 'vybe:metrics-sampled', v = sessionStorage.getItem(k)
    // Automated browsers (lab checks) are never sampled unless a check opts in by setting the key itself.
    sampled = v ? v === '1' : !navigator.webdriver && Math.random() < rate
    sessionStorage.setItem(k, sampled ? '1' : '0')
  } catch { sampled = !navigator.webdriver && Math.random() < rate }
  if (!sampled) return false
  field.on = true; field.send = send
  observeVitals()
  addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') { finalVitals(); flushField() } })
  addEventListener('pagehide', () => { finalVitals(); flushField() })
  return true
}

// ------------------------------------------------------------------ Web Vitals (no library: the standard observers)
let lcp = 0, cls = 0, inp = 0, vitalsDone = false
function observeVitals() {
  const obs = (type: string, cb: (list: PerformanceEntryList) => void, extra: Record<string, unknown> = {}) => {
    try { new PerformanceObserver(l => cb(l.getEntries())).observe({ type, buffered: true, ...extra } as PerformanceObserverInit) } catch { /* unsupported here */ }
  }
  const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
  if (nav && nav.responseStart > 0) record('ttfb', nav.responseStart)
  obs('paint', es => { for (const e of es) if (e.name === 'first-contentful-paint') record('fcp', e.startTime) })
  obs('largest-contentful-paint', es => { const e = es[es.length - 1]; if (e) lcp = e.startTime })
  // CLS: the largest burst of shifts (gaps under 1 s, at most 5 s long) not caused by the person's own input.
  let win = 0, first = 0, last = 0
  obs('layout-shift', es => {
    for (const e of es as (PerformanceEntry & { value: number; hadRecentInput: boolean })[]) {
      if (e.hadRecentInput) continue
      if (win && e.startTime - last < 1000 && e.startTime - first < 5000) win += e.value
      else { win = e.value; first = e.startTime }
      last = e.startTime; cls = Math.max(cls, win)
    }
  })
  // INP (approximation for short sessions): the slowest interaction, from event timing.
  obs('event', es => { for (const e of es as (PerformanceEntry & { interactionId?: number })[]) if (e.interactionId) inp = Math.max(inp, e.duration) }, { durationThreshold: 40 })
  // LCP stops at the first input, as the standard defines it.
  for (const t of ['keydown', 'pointerdown']) addEventListener(t, () => { if (lcp && !vitalsDone) { record('lcp', lcp); lcp = -1 } }, { once: true, capture: true })
}
function finalVitals() {
  if (vitalsDone) return
  vitalsDone = true
  if (lcp > 0) record('lcp', lcp)
  record('cls', cls)
  if (inp > 0) record('inp', inp)
}

/** Time from navigation to the first posts on screen, once per page load. */
let firstPostDone = false
export function markFirstPost() {
  if (firstPostDone) return
  firstPostDone = true
  record('first_post', performance.now())
}

if (typeof window !== 'undefined') (window as unknown as { __vybeMetrics: unknown }).__vybeMetrics = { summarize, raw: (n: MetricName) => [...(store.get(n) ?? [])], field }
