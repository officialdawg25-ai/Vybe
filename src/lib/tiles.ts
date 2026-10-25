import { useEffect, useState } from 'react'
import {
  Baby, Drama, GraduationCap, Handshake, HeartHandshake, Laugh, Mic, MicVocal, Moon, Music2, Palette, Radio, Shapes, Sparkles, Star, Tent, Trophy,
  UsersRound, UtensilsCrossed, Wifi, Wrench, type LucideIcon,
} from 'lucide-react'
import { supabase } from './supabase'
import { putObject } from './media'
import type { Category } from './discover'

/**
 * Discover's category tiles. Event categories come from the admin-configured list (a new category gets a tile without a
 * code change); the others are fixed destinations. Each tile's cover is, in order: the picture or video an admin chose
 * (discover_tiles, public brand bucket), the artwork of a real upcoming plan in that category, or the tile's colour and icon.
 */
export interface TileDef { id: string; label: string; blurb: string; icon: LucideIcon; accent: string; kind: 'events' | 'artists' | 'communities' | 'live' }

const ICONS: Record<string, LucideIcon> = {
  concerts: MicVocal, festivals: Tent, comedy: Laugh, theatre: Drama, 'open-mic': Mic, nightlife: Moon, 'arts-culture': Palette, sports: Trophy,
  workshops: Wrench, networking: Handshake, food: UtensilsCrossed, family: Baby, student: GraduationCap, community: HeartHandshake, other: Shapes,
}
const ACCENTS = ['#e0457b', '#7c4dff', '#f08a24', '#1f9d8b', '#3b6fe0', '#c2410c', '#0f766e', '#9333ea', '#be123c', '#2563eb', '#b45309', '#0e7490', '#4d7c0f', '#a21caf', '#475569']
export const FIXED_TILES = ['music', 'things', 'artists', 'communities', 'live', 'online'] as const

export function buildTiles(cats: Category[]): TileDef[] {
  return [
    { id: 'music', label: 'Concerts & music', blurb: 'Gigs, shows and DJ sets', icon: Music2, accent: '#e0457b', kind: 'events' },
    { id: 'things', label: 'Things to do', blurb: 'Everything happening around you', icon: Sparkles, accent: '#7c4dff', kind: 'events' },
    ...cats.map((c, i): TileDef => ({ id: c.slug, label: c.label, blurb: c.group_key === 'concerts' ? 'Concerts & shows' : 'Events', icon: ICONS[c.slug] ?? Shapes, accent: ACCENTS[i % ACCENTS.length], kind: 'events' })),
    { id: 'artists', label: 'Artists & venues', blurb: 'Follow who’s behind the plans', icon: Star, accent: '#b45309', kind: 'artists' },
    { id: 'communities', label: 'Communities', blurb: 'Groups that meet up', icon: UsersRound, accent: '#0f766e', kind: 'communities' },
    { id: 'live', label: 'Live from events', blurb: 'Watch what’s on right now', icon: Radio, accent: '#be123c', kind: 'live' },
    { id: 'online', label: 'Online', blurb: 'Join from anywhere', icon: Wifi, accent: '#2563eb', kind: 'events' },
  ]
}

/* ------------------------------------------------------------- admin covers */
export interface TileMedia { path: string; url: string; video: boolean }
const VIDEO = /\.(mp4|webm)$/i
const publicUrl = (path: string) => supabase.storage.from('brand').getPublicUrl(path).data.publicUrl
let cache: Promise<Map<string, TileMedia>> | null = null
export const loadTileMedia = () => (cache ??= (async () => {
  const { data, error } = await supabase.from('discover_tiles').select('id,media_path')
  if (error) { cache = null; return new Map<string, TileMedia>() }   // not upgraded yet, or offline: tiles fall back to event art
  return new Map(((data ?? []) as { id: string; media_path: string | null }[]).filter(r => r.media_path).map(r => [r.id, { path: r.media_path!, url: publicUrl(r.media_path!), video: VIDEO.test(r.media_path!) }]))
})())
export const resetTileMedia = () => { cache = null }
export function useTileMedia() {
  const [m, setM] = useState<Map<string, TileMedia>>(new Map())
  useEffect(() => { let live = true; loadTileMedia().then(x => live && setM(x)); return () => { live = false } }, [])
  return m
}

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'video/mp4': 'mp4', 'video/webm': 'webm' }
/** Admins only (the database refuses everyone else). Replaces the previous file, which is then removed from storage. */
export async function setTileMedia(id: string, file: File | null, onProgress?: (sent: number, total: number) => void) {
  const before = (await loadTileMedia()).get(id)?.path
  let path: string | null = null
  if (file) {
    const ext = EXT[file.type]
    if (!ext) throw new Error('Use a JPG, PNG or WebP picture, or an MP4 or WebM video.')
    if (file.size > 50 * 1024 * 1024) throw new Error('Files must be 50 MB or smaller.')
    path = `discover/${crypto.randomUUID()}.${ext}`
    await putObject('brand', path, file, file.type, { onProgress })
  }
  const { error } = path
    ? await supabase.from('discover_tiles').upsert({ id, media_path: path, updated_at: new Date().toISOString() })
    : await supabase.from('discover_tiles').delete().eq('id', id)
  if (error) { if (path) await supabase.storage.from('brand').remove([path]); throw error }
  if (before && before !== path) await supabase.storage.from('brand').remove([before])
  resetTileMedia()
}
