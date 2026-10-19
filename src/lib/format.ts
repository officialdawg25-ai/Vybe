/** Relative time for feeds ("5m", "3h", "2d"), falling back to a locale date. */
export function timeAgo(iso: string, now = Date.now(), locale?: string): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000))
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(new Date(iso))
}

/** Events are stored as UTC instants plus an IANA zone; show them in the event's own zone. */
export function formatEventTime(iso: string, timeZone: string, locale?: string): string {
  const opts: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }
  try {
    return new Intl.DateTimeFormat(locale, { ...opts, timeZone }).format(new Date(iso))
  } catch {
    return new Intl.DateTimeFormat(locale, { ...opts, timeZone: 'UTC' }).format(new Date(iso))
  }
}

export function formatPrice(cents: number | null, currency: string | null, locale?: string): string {
  if (!cents) return 'Free'
  return new Intl.NumberFormat(locale, { style: 'currency', currency: currency || 'USD' }).format(cents / 100)
}

/** Convert a <input type="datetime-local"> value in `timeZone` to a UTC ISO instant (DST-safe). */
export function zonedLocalToUtc(local: string, timeZone: string): string {
  const [d, t] = local.split('T')
  const [y, mo, da] = d.split('-').map(Number)
  const [h, mi] = t.split(':').map(Number)
  const guess = Date.UTC(y, mo - 1, da, h, mi)
  const offset = (ts: number) => {
    const p = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ts))
    const g = (k: string) => Number(p.find(x => x.type === k)!.value)
    return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - ts
  }
  let ts = guess - offset(guess)
  ts = guess - offset(ts) // second pass resolves DST boundaries
  return new Date(ts).toISOString()
}

export const localTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

/** Inverse of zonedLocalToUtc: UTC instant -> "YYYY-MM-DDTHH:mm" wall time in `timeZone`. */
export function utcToZonedLocal(iso: string, timeZone: string): string {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(iso))
  const g = (k: string) => p.find(x => x.type === k)!.value
  return `${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}`
}
