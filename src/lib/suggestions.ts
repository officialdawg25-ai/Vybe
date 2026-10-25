import { supabase } from './supabase'
import { isMissingSchema } from './tickets'

/**
 * Suggestions shown in the Home feed: events, artists and people, ranked by the database (feed_suggestions, migration 26)
 * from this member's friends, follows, past RSVPs and saves, interests, place and what they liked. Each item carries the
 * main reason it was picked, so the card can say why honestly.
 */
export interface Reason { code: string; n?: number; label?: string; km?: number }
export interface SuggestedEvent {
  id: string; title: string; starts_at: string; timezone: string; city: string | null; venue: string | null; cover_path: string | null
  format: 'in_person' | 'online' | 'hybrid'; category_label: string | null; distance_km: number | null; going: number; friends_going: number; reason: Reason
}
export interface SuggestedArtist { id: string; name: string; slug: string; kind: string; avatar_path: string | null; verified: boolean; followers: number; upcoming: number; reason: Reason }
export interface SuggestedPerson { id: string; username: string; display_name: string; avatar_path: string | null; verified_until: string | null; reason: Reason }
export interface Suggestions { events: SuggestedEvent[]; artists: SuggestedArtist[]; people: SuggestedPerson[] }
export type SuggestionKind = 'event' | 'org' | 'profile'

const TTL = 5 * 60_000
let cache: { key: string; at: number; p: Promise<Suggestions | null> } | null = null

/** One request per account and place for five minutes (Home re-mounts often). Null: the database has no suggestions yet. */
export function loadSuggestions(uid: string, place?: { lat: number; lng: number } | null): Promise<Suggestions | null> {
  const key = `${uid}:${place ? `${place.lat.toFixed(2)},${place.lng.toFixed(2)}` : '-'}`
  if (cache && cache.key === key && Date.now() - cache.at < TTL) return cache.p
  const p = (async () => {
    const { data, error } = await supabase.rpc('feed_suggestions', { p_lat: place?.lat ?? null, p_lng: place?.lng ?? null, p_limit: 10 })
    if (error) { if (isMissingSchema(error)) return null; throw error }
    const d = (data ?? {}) as Partial<Suggestions>
    return { events: d.events ?? [], artists: d.artists ?? [], people: d.people ?? [] }
  })()
  p.catch(() => { if (cache?.p === p) cache = null })                     // a failure is not cached
  cache = { key, at: Date.now(), p }
  return p
}
export const resetSuggestions = () => { cache = null }

/** "Not interested": remembered on the server, so it does not come back on another device. */
export async function dismissSuggestion(kind: SuggestionKind, id: string) {
  const { error } = await supabase.rpc('dismiss_suggestion', { p_kind: kind, p_target: id })
  if (error) throw error
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
/** The sentence under a suggestion. Only facts the member may know: their own activity and public counts. */
export function reasonText(r: Reason): string {
  switch (r.code) {
    case 'friends_going': return `${plural(r.n ?? 1, 'friend', 'friends')} going`
    case 'artist_you_follow': return `${r.label} is playing`
    case 'you_follow_host': return 'From someone you follow'
    case 'like_your_events': return `Like events you've been to`
    case 'your_interests': return 'Matches your interests'                 // the card already shows the category
    case 'near_you': return r.km != null && r.km <= 1 ? 'Right near you' : `${r.km} km from you`
    case 'popular': return `Popular · ${r.n} going`
    case 'many_followers': return plural(r.n ?? 0, 'follower', 'followers')
    case 'plays_your_event': return `Playing ${r.label}`
    case 'you_liked_posts': return 'You liked their posts'
    case 'upcoming_events': return plural(r.n ?? 1, 'upcoming event', 'upcoming events')
    case 'follows_you': return 'Follows you'
    case 'mutual_friends': return plural(r.n ?? 1, 'mutual friend', 'mutual friends')
    case 'shared_interests': return `Into ${r.label}`
    case 'new_on_vybe': return 'New on VYBE'
    default: return 'Coming up'
  }
}
