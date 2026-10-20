import { supabase } from './supabase'
import { isMissingSchema } from './tickets'
import { uploadMedia, validateMedia, mediaPath } from './media'
import type { PublicProfile } from './types'

/* ----------------------------------------------------------------- feelings & activities (fixed keys stored on the post) */
export interface Mood { key: string; label: string; emoji: string; verb?: string }
export const FEELINGS: Mood[] = [
  { key: 'happy', label: 'happy', emoji: '😊' }, { key: 'blessed', label: 'blessed', emoji: '😇' }, { key: 'loved', label: 'loved', emoji: '🥰' }, { key: 'sad', label: 'sad', emoji: '😔' },
  { key: 'thankful', label: 'thankful', emoji: '🙏' }, { key: 'excited', label: 'excited', emoji: '🤩' }, { key: 'in-love', label: 'in love', emoji: '😍' }, { key: 'crazy', label: 'crazy', emoji: '🤪' },
  { key: 'grateful', label: 'grateful', emoji: '🥹' }, { key: 'fantastic', label: 'fantastic', emoji: '🤗' }, { key: 'silly', label: 'silly', emoji: '😜' }, { key: 'festive', label: 'festive', emoji: '🎉' },
  { key: 'cool', label: 'cool', emoji: '😎' }, { key: 'relaxed', label: 'relaxed', emoji: '😌' }, { key: 'chill', label: 'chill', emoji: '🧊' }, { key: 'hopeful', label: 'hopeful', emoji: '🌷' },
  { key: 'tired', label: 'tired', emoji: '😴' }, { key: 'motivated', label: 'motivated', emoji: '💪' }, { key: 'proud', label: 'proud', emoji: '🥳' }, { key: 'nostalgic', label: 'nostalgic', emoji: '📼' },
  { key: 'angry', label: 'angry', emoji: '😠' }, { key: 'anxious', label: 'anxious', emoji: '😟' }, { key: 'joyful', label: 'joyful', emoji: '😄' }, { key: 'lonely', label: 'lonely', emoji: '🌙' },
]
export const ACTIVITIES: Mood[] = [
  { key: 'listening', label: 'listening to music', emoji: '🎧', verb: 'listening to music' }, { key: 'watching', label: 'watching', emoji: '📺', verb: 'watching' }, { key: 'eating', label: 'eating', emoji: '🍽️', verb: 'eating' },
  { key: 'drinking', label: 'drinking', emoji: '🥂', verb: 'drinking' }, { key: 'celebrating', label: 'celebrating', emoji: '🎊', verb: 'celebrating' }, { key: 'traveling', label: 'travelling', emoji: '✈️', verb: 'travelling' },
  { key: 'playing', label: 'playing', emoji: '🎮', verb: 'playing' }, { key: 'reading', label: 'reading', emoji: '📖', verb: 'reading' }, { key: 'attending', label: 'attending an event', emoji: '🎟️', verb: 'attending an event' },
  { key: 'working-out', label: 'working out', emoji: '🏋️', verb: 'working out' }, { key: 'studying', label: 'studying', emoji: '📚', verb: 'studying' }, { key: 'dancing', label: 'dancing', emoji: '💃', verb: 'dancing' },
]
export const moodOf = (key?: string | null): (Mood & { activity: boolean }) | null => {
  if (!key) return null
  const f = FEELINGS.find(m => m.key === key); if (f) return { ...f, activity: false }
  const a = ACTIVITIES.find(m => m.key === key); return a ? { ...a, activity: true } : null
}
export const moodText = (m: ReturnType<typeof moodOf>) => (m ? `${m.activity ? '' : 'feeling '}${m.label}` : '')

export const isVerified = (p?: Pick<PublicProfile, 'verified_until'> | null, now = Date.now()) => Boolean(p?.verified_until && new Date(p.verified_until).getTime() > now)

/* ----------------------------------------------------------------- memories */
export const MEMORY_BG: Record<string, string> = {
  violet: 'linear-gradient(160deg, #7a5cff 0%, #3b2a8f 100%)', teal: 'linear-gradient(160deg, #1fa88a 0%, #0f5f6e 100%)', rose: 'linear-gradient(160deg, #e0457b 0%, #7a1f4d 100%)',
  sun: 'linear-gradient(160deg, #f5a524 0%, #c4491c 100%)', night: 'linear-gradient(160deg, #1d1b2e 0%, #0a0a14 100%)', ocean: 'linear-gradient(160deg, #2b7de9 0%, #123a7a 100%)',
}
export const REACTIONS = [{ key: 'heart', emoji: '❤️', label: 'Love' }, { key: 'like', emoji: '👍', label: 'Like' }, { key: 'laugh', emoji: '😂', label: 'Haha' }, { key: 'wow', emoji: '😮', label: 'Wow' }, { key: 'sad', emoji: '😢', label: 'Sad' }, { key: 'fire', emoji: '🔥', label: 'Fire' }] as const
export type ReactionKey = (typeof REACTIONS)[number]['key']
export const reactionEmoji = (k?: string | null) => REACTIONS.find(r => r.key === k)?.emoji ?? ''

export interface RailItem {
  author: PublicProfile; count: number; unseen: number; latest_at: string; friend: boolean
  cover: { kind: 'photo' | 'video' | 'text'; media_path: string | null; text_body: string; bg: string } | null
}
export interface Memory {
  id: string; kind: 'photo' | 'video' | 'text'; media_path: string | null; text_body: string; bg: string; created_at: string; expires_at: string
  visibility: 'public' | 'friends'; highlight: boolean; highlight_title: string | null; mine_reaction: ReactionKey | null; seen: boolean
  views: number | null; reactions: number | null; replies: number | null
}
export async function loadRail(): Promise<RailItem[] | null> {
  const { data, error } = await supabase.rpc('memory_rail', { p_limit: 30 })
  if (error) { if (isMissingSchema(error)) return null; throw error }
  return (Array.isArray(data) ? data : []) as RailItem[]
}
export async function authorMemories(author: string, highlights = false): Promise<Memory[]> {
  const { data, error } = await supabase.rpc('author_memories', { p_author: author, p_highlights: highlights })
  if (error) throw error
  return (Array.isArray(data) ? data : []) as Memory[]
}
export const markSeen = (id: string, uid: string) => void supabase.from('memory_views').insert({ memory_id: id, viewer: uid }).then(() => {}, () => {})
export async function setReaction(id: string, uid: string, emoji: ReactionKey | null, had: ReactionKey | null) {
  if (!emoji) { const { error } = await supabase.from('memory_reactions').delete().eq('memory_id', id).eq('user_id', uid); if (error) throw error; return }
  const { error } = had
    ? await supabase.from('memory_reactions').update({ emoji }).eq('memory_id', id).eq('user_id', uid)
    : await supabase.from('memory_reactions').insert({ memory_id: id, user_id: uid, emoji })
  if (error && (error as { code?: string }).code !== '23505') throw error
}
export async function replyToMemory(id: string, uid: string, r: { body?: string; audio?: { path: string; ms: number } }) {
  const { error } = await supabase.from('memory_replies').insert({ memory_id: id, author: uid, body: (r.body ?? '').trim(), audio_path: r.audio?.path ?? null, audio_ms: r.audio?.ms ?? null })
  if (error) throw new Error(/permission|row-level|violates/i.test(error.message) ? 'This person only receives replies from friends.' : error.message.includes('Slow down') ? 'Slow down a little.' : error.message)
}
export async function createMemory(uid: string, m: { kind: 'photo' | 'video' | 'text'; file?: File | null; text?: string; bg?: string; visibility: 'public' | 'friends' }) {
  let uploaded: { path: string; type: 'image' | 'video' } | null = null
  if (m.kind !== 'text') {
    if (!m.file) throw new Error('Choose a photo or video first.')
    uploaded = await uploadMedia(uid, m.file)
  }
  const { data, error } = await supabase.from('memories').insert({ author: uid, kind: m.kind, media_path: uploaded?.path ?? null, text_body: (m.text ?? '').trim(), bg: m.bg ?? 'violet', visibility: m.visibility }).select('id').single()
  if (error) { if (uploaded) await supabase.storage.from('media').remove([uploaded.path]); throw new Error(error.message.includes('a lot of memories') ? error.message : error.message) }
  return data.id as string
}
export { validateMedia, mediaPath }

/* ----------------------------------------------------------------- music */
export interface Track { id: string; title: string; artist: string; artwork_path: string | null; preview_path: string | null; external_url: string | null; saved: boolean }
export const brandUrl = (path: string) => supabase.storage.from('brand').getPublicUrl(path).data.publicUrl
export async function musicCatalog(tab: 'foryou' | 'trending' | 'saved', q = ''): Promise<Track[] | null> {
  const { data, error } = await supabase.rpc('music_catalog', { p_tab: tab, p_q: q.trim() || null, p_limit: 60 })
  if (error) { if (isMissingSchema(error)) return null; throw error }
  return (Array.isArray(data) ? data : []) as Track[]
}
export async function setTrackSaved(id: string, uid: string, on: boolean) {
  const { error } = on ? await supabase.from('saved_tracks').insert({ user_id: uid, track_id: id }) : await supabase.from('saved_tracks').delete().eq('user_id', uid).eq('track_id', id)
  if (error && !(on && (error as { code?: string }).code === '23505')) throw error
}

/* ----------------------------------------------------------------- profile details */
export interface Education { school: string; field?: string; from?: string; to?: string }
export interface Work { employer: string; role?: string }
export interface LinkItem { label: string; url: string }
export type Section = 'about' | 'personal' | 'work' | 'education' | 'hobbies' | 'travel' | 'links' | 'contact'
export type Vis = 'public' | 'friends' | 'me'
export const SECTIONS: { key: Section; label: string }[] = [
  { key: 'about', label: 'About you' }, { key: 'personal', label: 'Personal details' }, { key: 'work', label: 'Work' }, { key: 'education', label: 'Education' },
  { key: 'hobbies', label: 'Hobbies' }, { key: 'travel', label: 'Travel' }, { key: 'links', label: 'Links' }, { key: 'contact', label: 'Contact info' },
]
export const RELATIONSHIPS: Record<string, string> = { single: 'Single', in_a_relationship: 'In a relationship', engaged: 'Engaged', married: 'Married', complicated: 'It’s complicated', prefer_not: 'Prefer not to say' }
export interface DetailsRow {
  about: string; current_city: string | null; hometown: string | null; relationship: string | null; gender: string | null; birthday_visible: boolean
  languages: string[]; education: Education[]; work: Work[]; hobbies: string[]; travel: string[]; links: LinkItem[]; contact: Record<string, string>; visibility: Record<Section, Vis>
}
export const EMPTY_DETAILS: DetailsRow = {
  about: '', current_city: null, hometown: null, relationship: null, gender: null, birthday_visible: false, languages: [], education: [], work: [], hobbies: [], travel: [], links: [], contact: {},
  visibility: { about: 'public', personal: 'public', work: 'public', education: 'public', hobbies: 'public', travel: 'public', links: 'public', contact: 'friends' },
}
export interface ViewDetails {
  level: number; about?: string; personal?: { current_city: string | null; hometown: string | null; relationship: string | null; gender: string | null; languages: string[]; birthday: string | null }
  work?: Work[]; education?: Education[]; hobbies?: string[]; travel?: string[]; links?: LinkItem[]; contact?: Record<string, string>
}
export async function getProfileDetails(user: string, as?: 'public' | 'friend' | null): Promise<ViewDetails | null> {
  const { data, error } = await supabase.rpc('get_profile_details', { p_user: user, p_as: as ?? null })
  if (error) { if (isMissingSchema(error)) return { level: 1 }; throw error }
  return (data ?? null) as ViewDetails | null
}
export async function loadMyDetails(uid: string): Promise<DetailsRow> {
  const { data, error } = await supabase.from('profile_details').select('*').eq('user_id', uid).maybeSingle()
  if (error) throw error
  return data ? ({ ...EMPTY_DETAILS, ...data, visibility: { ...EMPTY_DETAILS.visibility, ...(data.visibility ?? {}) } } as DetailsRow) : EMPTY_DETAILS
}
export async function saveMyDetails(uid: string, d: DetailsRow) {
  const { error } = await supabase.from('profile_details').upsert({ user_id: uid, ...d, current_city: d.current_city || null, hometown: d.hometown || null, relationship: d.relationship || null, gender: d.gender || null })
  if (error) throw new Error(error.message)
}
export interface Stats { friends: number; followers: number | null; following: number | null; i_follow: boolean }
export async function profileStats(user: string): Promise<Stats | null> {
  const { data, error } = await supabase.rpc('profile_stats', { p_user: user })
  if (error) { if (isMissingSchema(error)) return null; throw error }
  return (data ?? null) as Stats | null
}
export const compactNumber = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M` : n >= 10_000 ? `${Math.round(n / 1000)}K` : n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K` : String(n))

/* ----------------------------------------------------------------- verification */
export interface Plan { id: string; label: string; days: number; price_cents: number; active: boolean; sort: number }
export async function loadPlans(): Promise<Plan[]> {
  const { data, error } = await supabase.from('verification_plans').select('id,label,days,price_cents,active,sort').eq('active', true).order('sort')
  if (error) { if (isMissingSchema(error)) return []; throw error }
  return (data ?? []) as Plan[]
}
