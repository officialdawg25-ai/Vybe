import { useEffect, useState } from 'react'
import { supabase } from './supabase'
import { isMissingSchema } from './tickets'
import { useAsync } from './hooks'

export interface Category { slug: string; label: string; group_key: 'concerts' | 'events'; sort: number; active: boolean }
export interface DiscoverEvent {
  id: string; title: string; starts_at: string; ends_at: string | null; timezone: string; city: string | null; venue: string | null; location: string | null
  cover_path: string | null; category: string | null; category_label: string | null; format: 'in_person' | 'online' | 'hybrid'
  lat: number | null; lng: number | null; distance_km: number | null; source: 'vybe' | 'external'; source_name: string | null
  price_from_cents: number | null; price_cents: number | null; currency: string | null; has_tickets: boolean
  going: number; friends_going: number; friend_avatars: { username: string; display_name: string; avatar_path: string | null }[]
  followed: boolean; live: boolean; artists: string[]
  host: { id: string; username: string; display_name: string; avatar_path: string | null } | null
  org: { id: string; name: string; slug: string; verified: boolean } | null
}
export interface OrgCard { id: string; name: string; slug: string; kind: string; description: string; avatar_path: string | null; verified: boolean; followers: number; upcoming: number; following: boolean }
export interface LiveItem {
  id: string; title: string; status: 'live' | 'scheduled'; access: 'open' | 'ticket'; scheduled_for: string | null; started_at: string | null; viewers: number | null; can_watch: boolean
  host: string | null; org: string | null; event: { id: string; title: string; city: string | null; venue: string | null; cover_path: string | null; starts_at: string; timezone: string; format: string }
}
export interface Social {
  going: number; interested: number; saved: boolean; mine: { status: string; visibility: 'public' | 'friends' | 'private' } | null
  people: { id: string; username: string; display_name: string; avatar_path: string | null; status: 'going' | 'maybe'; friend: boolean }[]
}

export const ORG_KIND_LABEL: Record<string, string> = { artist: 'Artist', creator: 'Creator', venue: 'Venue', organizer: 'Organiser', business: 'Business', brand: 'Brand' }

export interface DiscoverArgs {
  q?: string; group?: 'concerts' | 'events'; categories?: string[]; format?: 'online' | 'in_person'; free?: boolean | null; from?: string; to?: string | null
  lat?: number; lng?: number; radiusKm?: number; followed?: boolean; friends?: boolean; saved?: boolean; sort?: 'soonest' | 'nearest'; limit?: number; offset?: number
}
/** Null means the database has not been upgraded yet (callers show a plain notice instead of failing). */
export async function discoverEvents(a: DiscoverArgs): Promise<DiscoverEvent[] | null> {
  const { data, error } = await supabase.rpc('discover_events', {
    p_q: a.q?.trim() || null, p_group: a.group ?? null, p_categories: a.categories?.length ? a.categories : null, p_format: a.format ?? null, p_free: a.free ?? null,
    p_from: a.from ?? new Date().toISOString(), p_to: a.to ?? null, p_lat: a.lat ?? null, p_lng: a.lng ?? null, p_radius_km: a.radiusKm ?? null,
    p_followed: Boolean(a.followed), p_friends: Boolean(a.friends), p_saved: Boolean(a.saved), p_sort: a.sort ?? 'soonest', p_limit: a.limit ?? 20, p_offset: a.offset ?? 0,
  })
  if (error) { if (isMissingSchema(error)) return null; throw error }
  return (Array.isArray(data) ? data : []) as DiscoverEvent[]
}
export async function discoverOrgs(a: { kinds?: string[]; q?: string; followed?: boolean; limit?: number } = {}): Promise<OrgCard[] | null> {
  const { data, error } = await supabase.rpc('discover_orgs', { p_kinds: a.kinds ?? null, p_q: a.q?.trim() || null, p_followed: Boolean(a.followed), p_limit: a.limit ?? 24, p_offset: 0 })
  if (error) { if (isMissingSchema(error)) return null; throw error }
  return (Array.isArray(data) ? data : []) as OrgCard[]
}
export async function discoverLive(): Promise<LiveItem[] | null> {
  const { data, error } = await supabase.rpc('discover_live', { p_limit: 20 })
  if (error) { if (isMissingSchema(error)) return null; throw error }
  return (Array.isArray(data) ? data : []) as LiveItem[]
}
export async function eventSocial(id: string): Promise<Social | null> {
  const { data, error } = await supabase.rpc('event_social', { p_event: id })
  if (error) { if (isMissingSchema(error)) return null; throw error }
  return (data ?? null) as Social | null
}

/** Categories are admin-configured data. One shared copy per page load. */
let catCache: Promise<Category[]> | null = null
export const loadCategories = () => (catCache ??= (async () => {
  const { data, error } = await supabase.from('event_categories').select('slug,label,group_key,sort,active').order('sort')
  if (error) { catCache = null; return [] }
  return (data ?? []) as Category[]
})())
export const resetCategories = () => { catCache = null }
export function useCategories() {
  const [cats, setCats] = useState<Category[]>([])
  useEffect(() => { let live = true; loadCategories().then(c => live && setCats(c)); return () => { live = false } }, [])
  return cats.filter(c => c.active)
}

/* --------------------------------------------------------------- follows */
export type FollowType = 'profile' | 'organization'
export async function setFollow(type: FollowType, id: string, uid: string, on: boolean) {
  const { error } = on
    ? await supabase.from('follows').insert({ follower: uid, target_type: type, target_id: id })
    : await supabase.from('follows').delete().eq('follower', uid).eq('target_type', type).eq('target_id', id)
  // A duplicate insert (double tap, second tab) means they already follow: that is the state they asked for.
  if (error && !(on && (error as { code?: string }).code === '23505')) throw error
}
export function useFollowStats(type: FollowType, id: string) {
  return useAsync(async () => {
    const { data, error } = await supabase.rpc('follow_stats', { p_type: type, p_id: id })
    if (error) { if (isMissingSchema(error)) return null; throw error }
    return data as { followers: number; following: boolean }
  }, [type, id])
}

/* --------------------------------------------------------------- saved events */
export async function setSaved(eventId: string, uid: string, on: boolean) {
  const { error } = on ? await supabase.from('event_saves').insert({ user_id: uid, event_id: eventId }) : await supabase.from('event_saves').delete().eq('user_id', uid).eq('event_id', eventId)
  if (error && !(on && (error as { code?: string }).code === '23505')) throw error
}

/* --------------------------------------------------------------- calendar */
const icsDate = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
const icsText = (s: string) => s.replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/[,;]/g, m => `\\${m}`)
/** A standards-compliant .ics for "Add to calendar". Works on Android, iOS, Outlook and Google Calendar without any account link. */
export function eventIcs(e: { id: string; title: string; starts_at: string; ends_at: string | null; description?: string; venue?: string | null; address?: string | null; city?: string | null; online_url?: string | null }, origin: string): string {
  const start = new Date(e.starts_at), end = e.ends_at ? new Date(e.ends_at) : new Date(start.getTime() + 3 * 3600_000)
  const where = [e.venue, e.address, e.city].filter(Boolean).join(', ')
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//VYBE//Discover//EN', 'CALSCALE:GREGORIAN', 'BEGIN:VEVENT',
    `UID:${e.id}@vybe`, `DTSTAMP:${icsDate(new Date())}`, `DTSTART:${icsDate(start)}`, `DTEND:${icsDate(end)}`, `SUMMARY:${icsText(e.title)}`,
    ...(where ? [`LOCATION:${icsText(where)}`] : []), `DESCRIPTION:${icsText(`${(e.description ?? '').slice(0, 400)}\n${origin}/app/plans/${e.id}`.trim())}`, `URL:${origin}/app/plans/${e.id}`,
    'END:VEVENT', 'END:VCALENDAR'].join('\r\n')
}
export function downloadIcs(e: Parameters<typeof eventIcs>[0]) {
  const blob = new Blob([eventIcs(e, window.location.origin)], { type: 'text/calendar;charset=utf-8' })
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${e.title.replace(/[^\w]+/g, '-').slice(0, 40) || 'event'}.ics`
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000)
}

/* --------------------------------------------------------------- display helpers */
export const eventLabel = (e: { category_label?: string | null; format?: string; starts_at: string }) => {
  const past = new Date(e.starts_at).getTime() < Date.now()
  return `${past ? 'Happening now' : 'Upcoming'} ${(e.category_label ?? 'event').toLowerCase()}`.toUpperCase()
}
export const shortDate = (iso: string, tz: string) => new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', timeZone: tz }).format(new Date(iso))
export const dayOfWeek = (iso: string, tz: string) => new Intl.DateTimeFormat(undefined, { weekday: 'long', timeZone: tz }).format(new Date(iso))
export const startTime = (iso: string, tz: string) => new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz }).format(new Date(iso))
export const fullDate = (iso: string, tz: string) => new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: tz }).format(new Date(iso))
/** "22 Oct – 30 Dec" for several dates, "30 Oct" for one. */
export function dateSpan(dates: { starts_at: string; timezone: string }[]) {
  if (!dates.length) return ''
  const s = [...dates].sort((a, b) => a.starts_at.localeCompare(b.starts_at)), a = s[0], b = s[s.length - 1]
  const x = shortDate(a.starts_at, a.timezone), y = shortDate(b.starts_at, b.timezone)
  return x === y ? x : `${x} – ${y}`
}

export type Range = 'any' | 'today' | 'weekend' | 'week'
/** Resolves a date-range chip to [from, to] ISO bounds in the viewer's local time. */
export function rangeBounds(r: Range, now = new Date()): { from: string; to: string | null } {
  const start = new Date(now); start.setHours(0, 0, 0, 0)
  const day = (d: Date, add: number) => { const x = new Date(d); x.setDate(x.getDate() + add); return x }
  if (r === 'today') return { from: now.toISOString(), to: day(start, 1).toISOString() }
  if (r === 'week') return { from: now.toISOString(), to: day(start, 8).toISOString() }
  if (r === 'weekend') {
    const dow = start.getDay()                                   // 0 Sun … 6 Sat
    const sat = dow === 0 ? day(start, -1) : day(start, 6 - dow)  // Sunday: the weekend is already running
    return { from: new Date(Math.max(now.getTime(), sat.getTime())).toISOString(), to: day(sat, 2).toISOString() }
  }
  return { from: now.toISOString(), to: null }
}
