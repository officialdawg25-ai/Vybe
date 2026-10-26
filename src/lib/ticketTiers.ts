import type { TicketDesign, TierKey } from './tickets'

/**
 * How each ticket tier looks. Organisers pick the tier (and optionally their own accent colour, a design and perks) on
 * the ticket type; buyers see the same branded stub in the event, at checkout, on the success screen and in My tickets.
 */
export interface TierLook { label: string; short: string; from: string; to: string; ink: string; glow: string }
export const TIERS: Record<TierKey, TierLook> = {
  general:    { label: 'General',    short: 'GA',    from: '#6a4cff', to: '#9d7bff', ink: '#ffffff', glow: 'rgba(106,76,255,.35)' },
  early_bird: { label: 'Early bird', short: 'EARLY', from: '#0f9d8a', to: '#45d3b8', ink: '#ffffff', glow: 'rgba(15,157,138,.35)' },
  vip:        { label: 'VIP',        short: 'VIP',   from: '#1a1408', to: '#4a3a12', ink: '#f3d27a', glow: 'rgba(201,162,39,.4)' },
  vvip:       { label: 'VVIP',       short: 'VVIP',  from: '#0b0b0f', to: '#2a2238', ink: '#e9d8ff', glow: 'rgba(176,132,255,.45)' },
  backstage:  { label: 'Backstage',  short: 'BACK',  from: '#b3122e', to: '#ff4d6d', ink: '#ffffff', glow: 'rgba(255,77,109,.35)' },
  student:    { label: 'Student',    short: 'STU',   from: '#1d63c9', to: '#5aa2ff', ink: '#ffffff', glow: 'rgba(29,99,201,.35)' },
  table:      { label: 'Table',      short: 'TABLE', from: '#0e6b3d', to: '#2fbf71', ink: '#ffffff', glow: 'rgba(47,191,113,.35)' },
  group:      { label: 'Group',      short: 'GROUP', from: '#c2410c', to: '#fb923c', ink: '#ffffff', glow: 'rgba(251,146,60,.35)' },
}
export const TIER_KEYS = Object.keys(TIERS) as TierKey[]
export const DESIGNS: { id: TicketDesign; label: string }[] = [
  { id: 'aurora', label: 'Aurora' }, { id: 'foil', label: 'Foil' }, { id: 'mesh', label: 'Mesh' }, { id: 'minimal', label: 'Minimal' },
]
/** Accent swatches offered to organisers (any #rrggbb is accepted by the database). */
export const SWATCHES = ['#6a4cff', '#c9a227', '#e11d48', '#0ea5e9', '#10b981', '#f97316', '#111827', '#ec4899']

export const isHex = (s: string | null | undefined): s is string => Boolean(s && /^#[0-9a-fA-F]{6}$/.test(s))
/** A lighter companion for an organiser's accent, for the gradient's second stop. */
export function lighten(hex: string, amount = 0.35) {
  const n = parseInt(hex.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255
  const m = (v: number) => Math.round(v + (255 - v) * amount)
  return `#${((1 << 24) | (m(r) << 16) | (m(g) << 8) | m(b)).toString(16).slice(1)}`
}
/** Relative luminance (WCAG); picks readable ink for a custom accent. */
export function luminance(hex: string) {
  const n = parseInt(hex.slice(1), 16)
  const ch = (v: number) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
  return 0.2126 * ch(n >> 16) + 0.7152 * ch((n >> 8) & 255) + 0.0722 * ch(n & 255)
}
export function tierStyle(tier: TierKey | undefined, accent?: string | null) {
  const t = TIERS[tier ?? 'general'] ?? TIERS.general
  if (!isHex(accent)) return t
  const from = accent, to = lighten(accent, 0.28)
  return { ...t, from, to, ink: luminance(from) > 0.45 ? '#120c24' : '#ffffff', glow: `${accent}59` }
}
/** Best guess of a tier from a ticket name, for servers before migration 32 and for new ticket forms. */
export function guessTier(name: string, kind?: string): TierKey {
  if (/\bvvip\b/i.test(name)) return 'vvip'
  if (/\bvip\b/i.test(name)) return 'vip'
  if (/early\s*bird/i.test(name)) return 'early_bird'
  if (/backstage/i.test(name)) return 'backstage'
  if (/student/i.test(name)) return 'student'
  if (/\btable\b/i.test(name)) return 'table'
  return kind === 'group' ? 'group' : 'general'
}
